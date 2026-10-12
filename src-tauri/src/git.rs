//! Read-only Git inspection. No executable, credentials, network or mutation API.
use crate::{
    error::NativeError,
    filesystem::{paths, Filesystem},
};
use git2::{
    Delta, Diff, DiffFindOptions, DiffOptions, Oid, Patch, Repository, RepositoryOpenFlags,
};
use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const MAX_BYTES: usize = 1024 * 1024;
const DIRECTORY_LIMIT: usize = 2048;
fn git_error(error: git2::Error) -> NativeError {
    NativeError::new("EGIT", error.message())
}
fn io(error: std::io::Error) -> NativeError {
    NativeError::from_io(&error, "Unable to inspect Git repository")
}
fn invalid(message: &str) -> NativeError {
    NativeError::new("EINVAL", message)
}

// Passive attributes only: libgit2 must never cause a placeholder download.
pub fn local(path: &Path) -> Result<(), NativeError> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if metadata.file_type().is_symlink() {
        return Err(invalid(
            "Symbolic Git administration paths are not supported",
        ));
    }
    #[cfg(target_os = "macos")]
    if crate::filesystem::availability::is_dataless(&metadata) {
        return Err(NativeError::new(
            "ECONTENT_UNAVAILABLE",
            "Git requires local content; cloud placeholders are not downloaded",
        ));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & (0x1000 | 0x40000 | 0x400000) != 0 {
            return Err(NativeError::new(
                "ECONTENT_UNAVAILABLE",
                "Git requires local content; cloud placeholders are not downloaded",
            ));
        }
    }
    let _ = metadata;
    Ok(())
}
fn local_if_exists(path: &Path) -> Result<(), NativeError> {
    match fs::symlink_metadata(path) {
        Ok(_) => local(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}
fn preflight_admin(root: &Path) -> Result<(), NativeError> {
    local(root)?;
    let marker = root.join(".git");
    local(&marker)?;
    let meta = fs::symlink_metadata(&marker).map_err(io)?;
    if meta.file_type().is_symlink() {
        return Err(invalid("Symbolic .git markers are not supported"));
    }
    let git_dir = if meta.is_file() {
        if meta.len() > 8192 {
            return Err(invalid("Invalid .git pointer"));
        }
        let content = fs::read_to_string(&marker).map_err(io)?;
        root.join(
            content
                .trim()
                .strip_prefix("gitdir: ")
                .ok_or_else(|| invalid("Invalid .git pointer"))?,
        )
    } else {
        marker
    };
    local(&git_dir)?;
    for name in ["HEAD", "config", "commondir", "index", "packed-refs"] {
        local_if_exists(&git_dir.join(name))?;
    }
    let common = git_dir.join("commondir");
    let common_dir = if common.exists() {
        git_dir.join(fs::read_to_string(common).map_err(io)?.trim())
    } else {
        git_dir.clone()
    };
    local(&common_dir)?;
    for name in ["config", "packed-refs", "index", "info/exclude", "shallow"] {
        local_if_exists(&common_dir.join(name))?;
    }
    Ok(())
}
fn preflight_objects(repo: &Repository) -> Result<(), NativeError> {
    if repo.commondir().join("objects/info/alternates").exists() {
        return Err(NativeError::new(
            "EGIT_ALTERNATES",
            "Git object alternates are not supported by safe local inspection",
        ));
    }
    let mut queue = VecDeque::from([
        repo.commondir().join("objects"),
        repo.path().join("refs"),
        repo.commondir().join("refs"),
    ]);
    let mut count = 0usize;
    while let Some(dir) = queue.pop_front() {
        if !dir.exists() {
            continue;
        }
        local(&dir)?;
        for entry in fs::read_dir(dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let path = entry.path();
            local(&path)?;
            let kind = entry.file_type().map_err(io)?;
            if kind.is_symlink() {
                return Err(invalid(
                    "Symbolic Git administration paths are not supported",
                ));
            }
            if kind.is_dir() {
                queue.push_back(path);
            }
            count += 1;
            if count > 100000 {
                return Err(NativeError::new(
                    "EGIT_LIMIT",
                    "Git object metadata budget reached",
                ));
            }
        }
    }
    Ok(())
}
pub fn open(filesystem: &Filesystem, requested: &str) -> Result<Repository, NativeError> {
    let logical = paths::resolve_inside_root(filesystem, requested)?;
    let root = paths::verify_existing_inside_root(filesystem, &logical)?;
    preflight_admin(&root)?;
    let repo = Repository::open_ext(
        &root,
        RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .map_err(git_error)?;
    if repo.is_bare()
        || repo
            .workdir()
            .and_then(|path| fs::canonicalize(path).ok())
            .as_ref()
            != Some(&root)
    {
        return Err(invalid("Not a working-tree repository root"));
    }
    Ok(repo)
}
pub fn identity(repo: &Repository) -> Value {
    let root = fs::canonicalize(repo.workdir().unwrap())
        .unwrap_or_else(|_| repo.workdir().unwrap().to_path_buf());
    json!({"id": root.to_string_lossy(), "path": root.to_string_lossy(), "name": root.file_name().map(|s| s.to_string_lossy()),
        "gitDir": repo.path().to_string_lossy(), "commonDir": repo.commondir().to_string_lossy()})
}

pub fn directories(
    repo: &Repository,
    check_files: bool,
) -> Result<(Vec<PathBuf>, bool), NativeError> {
    let root = repo
        .workdir()
        .ok_or_else(|| invalid("A working tree is required"))?;
    let mut result = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut files = 0usize;
    // Index entries are important even when tracked files now match ignore rules.
    if let Ok(exclude) = repo
        .config()
        .map_err(git_error)?
        .get_path("core.excludesfile")
    {
        local_if_exists(&exclude)?;
    }
    let index = repo.index().map_err(git_error)?;
    let tracked: HashSet<PathBuf> = index
        .iter()
        .map(|entry| PathBuf::from(String::from_utf8_lossy(&entry.path).as_ref()))
        .collect();
    let mut tracked_dirs = HashSet::new();
    for path in &tracked {
        let mut parent = path.parent();
        while let Some(dir) = parent {
            tracked_dirs.insert(dir.to_path_buf());
            parent = dir.parent();
        }
    }
    while let Some(dir) = queue.pop_front() {
        if result.len() >= DIRECTORY_LIMIT {
            return Ok((result, true));
        }
        local(&dir)?;
        result.push(dir.clone());
        // Ignore parsing reads .gitignore; protect it first.
        local_if_exists(&dir.join(".gitignore"))?;
        for entry in fs::read_dir(&dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let file = entry.path();
            let kind = entry.file_type().map_err(io)?;
            if entry.file_name() == ".git" || kind.is_symlink() {
                continue;
            }
            let relative = file
                .strip_prefix(root)
                .map_err(|_| invalid("Invalid repository path"))?;
            if !tracked.contains(relative)
                && !tracked_dirs.contains(relative)
                && repo.status_should_ignore(relative).map_err(git_error)?
            {
                continue;
            }
            if kind.is_dir() {
                if file.join(".git").exists() {
                    continue;
                }
                queue.push_back(file);
            } else if check_files {
                files += 1;
                if files > 100000 {
                    return Err(NativeError::new(
                        "EGIT_LIMIT",
                        "Repository content preflight limit reached",
                    ));
                }
                local(&file)?;
            }
        }
    }
    Ok((result, false))
}
fn preflight(repo: &Repository) -> Result<(), NativeError> {
    let (_, limited) = directories(repo, true)?;
    if limited {
        return Err(NativeError::new(
            "EGIT_LIMIT",
            "Repository exceeds the safe inspection directory budget",
        ));
    }
    Ok(())
}
fn oid(sha: Option<&str>) -> Result<Oid, NativeError> {
    let sha = sha.ok_or_else(|| invalid("A commit SHA is required"))?;
    if sha.len() != 40 {
        return Err(invalid("A full commit SHA is required"));
    }
    Oid::from_str(sha).map_err(git_error)
}
fn relative(file: &str) -> Result<(), NativeError> {
    if file.is_empty()
        || Path::new(file).is_absolute()
        || file.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(invalid("Invalid repository-relative file path"));
    }
    Ok(())
}
fn commit_info(commit: &git2::Commit<'_>) -> Value {
    json!({"sha": commit.id().to_string(), "subject": commit.summary().unwrap_or(""), "message": commit.message().unwrap_or("").trim_end(),
        "author": commit.author().name().unwrap_or(""), "email": commit.author().email().unwrap_or(""), "timestamp": commit.time().seconds(),
        "parents": commit.parent_ids().map(|id| id.to_string()).collect::<Vec<_>>()})
}
fn diff<'a>(
    repo: &'a Repository,
    scope: &str,
    sha: Option<&str>,
    file: Option<&str>,
    old: Option<&str>,
) -> Result<Diff<'a>, NativeError> {
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true)
        .max_size(MAX_BYTES as i64);
    if let Some(file) = file {
        relative(file)?;
        options.disable_pathspec_match(true).pathspec(file);
    }
    if let Some(old) = old {
        relative(old)?;
        options.pathspec(old);
    }
    let mut result = match scope {
        "staged" => {
            let tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
            repo.diff_tree_to_index(tree.as_ref(), None, Some(&mut options))
        }
        "unstaged" | "untracked" => repo.diff_index_to_workdir(None, Some(&mut options)),
        "commit" => {
            let commit = repo.find_commit(oid(sha)?).map_err(git_error)?;
            let tree = commit.tree().map_err(git_error)?;
            let parent = if commit.parent_count() > 0 {
                Some(
                    commit
                        .parent(0)
                        .map_err(git_error)?
                        .tree()
                        .map_err(git_error)?,
                )
            } else {
                None
            };
            repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut options))
        }
        _ => return Err(invalid("Invalid diff scope")),
    }
    .map_err(git_error)?;
    result
        .find_similar(Some(DiffFindOptions::new().renames(true)))
        .map_err(git_error)?;
    Ok(result)
}
fn changed_files(diff: &Diff<'_>, scope: &str) -> Result<Vec<Value>, NativeError> {
    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let untracked = delta.status() == Delta::Untracked;
        if scope == "untracked" && !untracked {
            continue;
        }
        let new = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .unwrap_or_else(|| Path::new(""));
        let old = if delta.status() == Delta::Renamed {
            delta.old_file().path().map(|path| path.to_string_lossy())
        } else {
            None
        };
        let patch = Patch::from_diff(diff, index).map_err(git_error)?;
        let (_, additions, deletions) = patch
            .as_ref()
            .map(|patch| patch.line_stats())
            .transpose()
            .map_err(git_error)?
            .unwrap_or_default();
        let status = match delta.status() {
            Delta::Added => "added",
            Delta::Deleted => "deleted",
            Delta::Renamed => "renamed",
            Delta::Untracked => "untracked",
            Delta::Conflicted => "conflicted",
            _ => "modified",
        };
        files.push(json!({"path": new.to_string_lossy(), "oldPath": old, "scope": if untracked {"untracked"} else {scope}, "status": status,
            "additions": additions, "deletions": deletions, "binary": delta.flags().contains(git2::DiffFlags::BINARY), "oversized": delta.old_file().size() > MAX_BYTES as u64 || delta.new_file().size() > MAX_BYTES as u64}));
    }
    Ok(files)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub filesystem_id: String,
    pub path: Option<String>,
    pub paths: Option<Vec<String>>,
    pub sha: Option<String>,
    pub file: Option<String>,
    pub old_path: Option<String>,
    pub scope: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}
pub fn operation(
    filesystem: &Filesystem,
    operation: &str,
    request: Request,
) -> Result<Value, NativeError> {
    if request.filesystem_id != "local" {
        return Err(NativeError::new(
            "EFILESYSTEM_ID",
            "Git is available only for local filesystems",
        ));
    }
    if operation == "detect" {
        let paths = request.paths.unwrap_or_default();
        if paths.len() > 256 {
            return Err(invalid("Git detection accepts at most 256 directories"));
        }
        let mut repositories = Vec::new();
        for requested in paths {
            if let Ok(repo) = open(filesystem, &requested) {
                let mut info = identity(&repo);
                info["requestedPath"] = json!(requested);
                repositories.push(info);
            }
        }
        return Ok(json!({"repositories": repositories}));
    }
    let repo = open(
        filesystem,
        request
            .path
            .as_deref()
            .ok_or_else(|| invalid("Repository path is required"))?,
    )?;
    preflight_objects(&repo)?;
    match operation {
        "status" => {
            preflight(&repo)?;
            let head = repo.head().ok();
            let detached = repo.head_detached().unwrap_or(false);
            let branch = if !detached {
                head.as_ref()
                    .and_then(|head| head.shorthand())
                    .map(str::to_owned)
                    .or_else(|| {
                        repo.find_reference("HEAD").ok().and_then(|head| {
                            head.symbolic_target()
                                .map(|target| target.trim_start_matches("refs/heads/").to_owned())
                        })
                    })
            } else {
                None
            };
            let mut files = changed_files(&diff(&repo, "staged", None, None, None)?, "staged")?;
            files.extend(changed_files(
                &diff(&repo, "unstaged", None, None, None)?,
                "unstaged",
            )?);
            Ok(
                json!({"repository": identity(&repo), "branch": branch, "head": head.and_then(|head| head.target()).map(|id| id.to_string()), "detached": detached, "files": files}),
            )
        }
        "branches" => Ok(
            json!({"branches": repo.branches(Some(git2::BranchType::Local)).map_err(git_error)?.filter_map(|branch| branch.ok().and_then(|(branch, _)| branch.name().ok().flatten().map(str::to_owned))).collect::<Vec<_>>()}),
        ),
        "log" => {
            let mut walker = repo.revwalk().map_err(git_error)?;
            if walker.push_head().is_err() {
                return Ok(json!({"commits": [], "hasMore": false}));
            }
            walker
                .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
                .map_err(git_error)?;
            let limit = request.limit.unwrap_or(50).clamp(1, 100);
            let offset = request.offset.unwrap_or(0);
            let mut commits = Vec::new();
            for id in walker.skip(offset).take(limit + 1) {
                commits.push(commit_info(
                    &repo
                        .find_commit(id.map_err(git_error)?)
                        .map_err(git_error)?,
                ));
            }
            let has_more = commits.len() > limit;
            commits.truncate(limit);
            Ok(json!({"commits": commits, "hasMore": has_more}))
        }
        "commit" => {
            let commit = repo
                .find_commit(oid(request.sha.as_deref())?)
                .map_err(git_error)?;
            Ok(
                json!({"commit": commit_info(&commit), "files": changed_files(&diff(&repo, "commit", request.sha.as_deref(), None, None)?, "commit")?}),
            )
        }
        "diff" => {
            let scope = request
                .scope
                .as_deref()
                .ok_or_else(|| invalid("Diff scope is required"))?;
            if scope != "commit" {
                preflight(&repo)?;
            }
            let file = request
                .file
                .as_deref()
                .ok_or_else(|| invalid("A file path is required"))?;
            let data = diff(
                &repo,
                scope,
                request.sha.as_deref(),
                Some(file),
                request.old_path.as_deref(),
            )?;
            let mut patch_text = Vec::new();
            let mut binary = false;
            let mut oversized = false;
            for (index, delta) in data.deltas().enumerate() {
                if scope == "untracked" && delta.status() != Delta::Untracked {
                    continue;
                }
                oversized |= delta.old_file().size() > MAX_BYTES as u64
                    || delta.new_file().size() > MAX_BYTES as u64;
                if oversized {
                    continue;
                }
                if let Some(mut patch) = Patch::from_diff(&data, index).map_err(git_error)? {
                    patch
                        .print(&mut |_, _, line| {
                            if matches!(line.origin(), '+' | '-' | ' ') {
                                patch_text.push(line.origin() as u8);
                            }
                            patch_text.extend_from_slice(line.content());
                            patch_text.len() <= MAX_BYTES
                        })
                        .or_else(|e| {
                            if patch_text.len() > MAX_BYTES {
                                oversized = true;
                                Ok(())
                            } else {
                                Err(e)
                            }
                        })
                        .map_err(git_error)?;
                } else {
                    binary = true;
                }
                binary |= delta.flags().contains(git2::DiffFlags::BINARY);
            }
            Ok(
                json!({"patch": if binary || oversized {String::new()} else {String::from_utf8_lossy(&patch_text).into_owned()}, "binary": binary, "oversized": oversized}),
            )
        }
        _ => Err(invalid("Unsupported read-only Git operation")),
    }
}

struct WatchRecord {
    wake: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    _thread: std::thread::JoinHandle<()>,
}
impl Drop for WatchRecord {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub struct GitWatches {
    records: Mutex<HashMap<String, WatchRecord>>,
}
impl GitWatches {
    pub fn watch(
        &self,
        filesystem: &Filesystem,
        requested: &str,
        app: AppHandle,
    ) -> Result<Value, NativeError> {
        let repo = open(filesystem, requested)?;
        let info = identity(&repo);
        let id = info["id"].as_str().unwrap().to_owned();
        let mut records = self.records.lock().unwrap();
        if records
            .get(&id)
            .map(|record| record.stopped.load(Ordering::Acquire))
            .unwrap_or(false)
        {
            records.remove(&id);
        }
        if !records.contains_key(&id) {
            if records.len() >= 16 {
                return Err(NativeError::new(
                    "EGIT_WATCH_LIMIT",
                    "Open repository watch limit reached",
                ));
            }
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = Arc::clone(&stopped);
            let wake = Arc::new(AtomicBool::new(true));
            let refresh = Arc::clone(&wake);
            let root = repo.workdir().unwrap().to_path_buf();
            let key = id.clone();
            let (ready_send, ready_receive) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                monitor(
                    root,
                    key,
                    stop,
                    refresh,
                    move |payload| {
                        let _ = app.emit("git:changed", payload);
                    },
                    Some(ready_send),
                )
            });
            records.insert(
                id.clone(),
                WatchRecord {
                    wake,
                    stopped,
                    _thread: thread,
                },
            );
            let (watching, error) = ready_receive
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| NativeError::new("EGIT_WATCH", "Watcher setup timed out"))?;
            return Ok(
                json!({"repository": info, "watching": watching, "error": error.map(|message| json!({"code": "EGIT_WATCH", "message": message}))}),
            );
        }
        if let Some(record) = records.get(&id) {
            record.wake.store(true, Ordering::Release);
        }
        Ok(json!({"repository": info, "watching": true}))
    }
    pub fn unwatch(&self, requested: &str) {
        let canonical = fs::canonicalize(requested)
            .unwrap_or_else(|_| PathBuf::from(requested))
            .to_string_lossy()
            .into_owned();
        self.records.lock().unwrap().remove(&canonical);
    }
}
fn watch_paths(repo: &Repository) -> Result<(HashSet<PathBuf>, bool), NativeError> {
    let (dirs, limited) = directories(repo, false)?;
    let mut desired: HashSet<PathBuf> = dirs.into_iter().collect();
    for root in [repo.path(), repo.commondir()] {
        desired.insert(root.to_path_buf());
        let mut queue = VecDeque::from([root.join("refs"), root.join("logs")]);
        while let Some(dir) = queue.pop_front() {
            if desired.len() >= DIRECTORY_LIMIT + 256 {
                return Ok((desired, true));
            }
            if !dir.exists() {
                continue;
            }
            local(&dir)?;
            desired.insert(dir.clone());
            for entry in fs::read_dir(dir).map_err(io)? {
                let entry = entry.map_err(io)?;
                if entry.file_type().map_err(io)?.is_dir() {
                    queue.push_back(entry.path());
                }
            }
        }
    }
    Ok((desired, limited))
}
fn monitor(
    root: PathBuf,
    id: String,
    stopped: Arc<AtomicBool>,
    wake: Arc<AtomicBool>,
    emit: impl Fn(Value),
    mut ready: Option<std::sync::mpsc::Sender<(bool, Option<String>)>>,
) {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let mut watcher = match notify::recommended_watcher(
        move |event: notify::Result<notify::Event>| {
            // A bounded channel coalesces bursts before they can allocate a queue.
            let _ = send.try_send(event.map(|_| ()));
        },
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            emit(
                json!({"repositoryId": id, "error": {"code": "EGIT_WATCH", "message": error.to_string()}}),
            );
            if let Some(send) = ready.take() {
                let _ = send.send((false, Some(error.to_string())));
            }
            stopped.store(true, Ordering::Release);
            return;
        }
    };
    let mut watched = HashSet::new();
    let mut dirty = true;
    let mut last = std::time::Instant::now();
    let mut recovery = last;
    while !stopped.load(Ordering::Acquire) {
        if wake.swap(false, Ordering::AcqRel) {
            dirty = true;
        }
        if dirty && last.elapsed() >= Duration::from_millis(180) {
            dirty = false;
            let mut error = None;
            let topology = preflight_admin(&root)
                .and_then(|_| {
                    Repository::open_ext(
                        &root,
                        RepositoryOpenFlags::NO_SEARCH,
                        std::iter::empty::<&Path>(),
                    )
                    .map_err(git_error)
                })
                .and_then(|repo| watch_paths(&repo));
            match topology {
                Ok((desired, limited)) => {
                    for old in watched.difference(&desired) {
                        let _ = watcher.unwatch(old);
                    }
                    watched.retain(|old| desired.contains(old));
                    let mut added = Vec::new();
                    for path in desired.difference(&watched) {
                        if let Err(e) = watcher.watch(path, RecursiveMode::NonRecursive) {
                            error = Some(e.to_string());
                        } else {
                            added.push(path.clone());
                        }
                    }
                    watched.extend(added);
                    if limited {
                        error = Some(
                            "Watcher directory budget reached; periodic recovery is active".into(),
                        );
                    }
                }
                Err(e) => error = Some(e.message),
            }
            if let Some(send) = ready.take() {
                let _ = send.send((!watched.is_empty(), error.clone()));
            }
            emit(
                json!({"repositoryId": id, "path": root.to_string_lossy(), "error": error.map(|message| json!({"code": "EGIT_WATCH", "message": message}))}),
            );
        }
        match receive.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => {
                if let Err(error) = event {
                    for path in &watched {
                        let _ = watcher.unwatch(path);
                    }
                    watched.clear();
                    emit(
                        json!({"repositoryId": id, "error": {"code": "EGIT_WATCH", "message": error.to_string()}}),
                    );
                }
                dirty = true;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            _ => (),
        }
        // Cap burst latency; event streams cannot postpone refresh indefinitely.
        if !dirty {
            last = std::time::Instant::now();
        }
        if recovery.elapsed() >= Duration::from_secs(30) {
            for path in &watched {
                let _ = watcher.unwatch(path);
            }
            watched.clear();
            dirty = true;
            recovery = std::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Filesystem, Repository) {
        let dir = std::env::temp_dir().join(format!("vesperwind-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let filesystem = Filesystem::from_root(&dir, dir.clone()).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (dir, filesystem, repo)
    }
    fn request(path: &Path, extra: Value) -> Request {
        let mut value = json!({"filesystemId": "local", "path": path.to_string_lossy()});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn commit(repo: &Repository, subject: &str) -> Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test Author", "test@example.test").unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            subject,
            &tree,
            &parent.as_ref().into_iter().collect::<Vec<_>>(),
        )
        .unwrap()
    }
    #[test]
    fn roots_empty_worktrees_and_local_only_contract() {
        let (root, filesystem, repo) = fixture();
        fs::create_dir(root.join("ordinary")).unwrap();
        let detected = operation(
            &filesystem,
            "detect",
            serde_json::from_value(
                json!({"filesystemId": "local", "paths": [root, root.join("ordinary")]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(detected["repositories"].as_array().unwrap().len(), 1);
        assert_eq!(
            operation(&filesystem, "log", request(&root, json!({}))).unwrap()["commits"],
            json!([])
        );
        fs::write(root.join("file.txt"), "first\n").unwrap();
        commit(&repo, "initial");
        let branch = repo
            .branch(
                "worktree",
                &repo.head().unwrap().peel_to_commit().unwrap(),
                false,
            )
            .unwrap();
        let mut options = git2::WorktreeAddOptions::new();
        options.reference(Some(branch.get()));
        let worktree = root.join("linked");
        repo.worktree("linked", &worktree, Some(&options)).unwrap();
        assert!(worktree.join(".git").is_file());
        assert_ne!(
            identity(&open(&filesystem, worktree.to_str().unwrap()).unwrap())["id"],
            identity(&repo)["id"]
        );
        let mut remote = request(&root, json!({}));
        remote.filesystem_id = "sftp".into();
        assert_eq!(
            operation(&filesystem, "status", remote).unwrap_err().code,
            "EFILESYSTEM_ID"
        );
        drop(branch);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_diffs_separate_index_and_worktree_without_writing_repository() {
        let (root, filesystem, repo) = fixture();
        fs::write(root.join("file.txt"), "first\n").unwrap();
        let first = commit(&repo, "initial");
        let initial = operation(
            &filesystem,
            "commit",
            request(&root, json!({"sha": first.to_string()})),
        )
        .unwrap();
        assert_eq!(initial["files"][0]["status"], "added");
        let initial_diff = operation(
            &filesystem,
            "diff",
            request(
                &root,
                json!({"sha": first.to_string(), "file": "file.txt", "scope": "commit"}),
            ),
        )
        .unwrap();
        assert!(initial_diff["patch"].as_str().unwrap().contains("+first"));
        fs::write(root.join("file.txt"), "staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        fs::write(root.join("file.txt"), "unstaged\n").unwrap();
        let bytes = fs::read(root.join(".git/index")).unwrap();
        let status = operation(&filesystem, "status", request(&root, json!({}))).unwrap();
        assert_eq!(status["files"][0]["scope"], "staged");
        assert_eq!(status["files"][1]["scope"], "unstaged");
        for (scope, expected) in [("staged", "+staged"), ("unstaged", "+unstaged")] {
            let diff = operation(
                &filesystem,
                "diff",
                request(&root, json!({"scope": scope, "file": "file.txt"})),
            )
            .unwrap();
            assert!(diff["patch"].as_str().unwrap().contains(expected));
        }
        assert_eq!(repo.head().unwrap().target(), Some(first));
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), bytes);
        fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
        assert_eq!(
            operation(
                &filesystem,
                "diff",
                request(&root, json!({"scope": "untracked", "file": "binary.bin"}))
            )
            .unwrap()["binary"],
            true
        );
        fs::write(root.join("large.txt"), vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert_eq!(
            operation(
                &filesystem,
                "diff",
                request(&root, json!({"scope": "untracked", "file": "large.txt"}))
            )
            .unwrap()["oversized"],
            true
        );
        fs::remove_file(root.join("file.txt")).unwrap();
        assert_eq!(
            operation(&filesystem, "status", request(&root, json!({}))).unwrap()["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|file| file["path"] == "file.txt" && file["scope"] == "unstaged")
                .unwrap()["status"],
            "deleted"
        );
        repo.set_head_detached(first).unwrap();
        assert_eq!(
            operation(&filesystem, "status", request(&root, json!({}))).unwrap()["detached"],
            true
        );
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_notify_observes_external_nested_writes_stage_commit_and_branch_then_stops() {
        let (root, filesystem, repo) = fixture();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/file.txt"), "first\n").unwrap();
        commit(&repo, "initial");
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        assert!(!directories(&repo, false)
            .unwrap()
            .0
            .contains(&root.join("ignored")));
        let (send, receive) = std::sync::mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let watched = root.clone();
        let thread = std::thread::spawn(move || {
            monitor(
                watched,
                "test".into(),
                stop,
                Arc::new(AtomicBool::new(false)),
                move |value| {
                    let _ = send.send(value);
                },
                None,
            )
        });
        let initial = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(initial["error"].is_null(), "{initial}");
        let next = || {
            while receive.try_recv().is_ok() {}
        };
        next();
        fs::write(root.join("nested/file.txt"), "external\n").unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(operation(
            &filesystem,
            "diff",
            request(
                &root,
                json!({"scope": "unstaged", "file": "nested/file.txt"})
            )
        )
        .unwrap()["patch"]
            .as_str()
            .unwrap()
            .contains("+external"));
        next();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("nested/file.txt")).unwrap();
        index.write().unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        next();
        commit(&repo, "external commit");
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            operation(&filesystem, "log", request(&root, json!({}))).unwrap()["commits"][0]
                ["subject"],
            "external commit"
        );
        next();
        repo.branch(
            "other",
            &repo.head().unwrap().peel_to_commit().unwrap(),
            false,
        )
        .unwrap();
        repo.set_head("refs/heads/other").unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            operation(&filesystem, "status", request(&root, json!({}))).unwrap()["branch"],
            "other"
        );
        stopped.store(true, Ordering::Release);
        thread.join().unwrap();
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
}
