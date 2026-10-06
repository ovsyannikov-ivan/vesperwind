//! Streaming provider reads used by native clipboard, file promises and
//! staging. Content is copied in bounded chunks; a remote file is never held
//! in memory as a whole.
use crate::error::NativeError;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CHUNK_SIZE: usize = 1024 * 1024;
/// Bound for one recursive remote selection (descriptor arrays, promises).
pub const MAX_TREE_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteStat {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<i64>,
}

/// The read side of a provider. Implemented by the SFTP provider; tests use
/// an in-memory implementation.
pub trait RemoteFiles: Send + Sync {
    fn stat(&self, provider: &str, path: &str) -> Result<RemoteStat, NativeError>;
    fn list(&self, provider: &str, path: &str) -> Result<Vec<RemoteStat>, NativeError>;
    fn open(&self, provider: &str, path: &str) -> Result<Box<dyn Read + Send>, NativeError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    /// Path components below the drop destination, starting with the
    /// selected item's own name. Every component is validated.
    pub relative: Vec<String>,
    pub remote_path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

fn cancelled() -> NativeError {
    NativeError::new("ECANCELLED", "The transfer was cancelled")
}

/// A remote name becomes a local path component. Never allow separators,
/// traversal or names Windows cannot represent; fail instead of renaming.
pub fn safe_component(name: &str) -> Result<String, NativeError> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 1024
        || name.chars().any(|c| c == '/' || c == '\\' || c == '\0');
    #[cfg(windows)]
    let invalid = invalid
        || name
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 32)
        || name.ends_with(['.', ' ']);
    if invalid {
        return Err(NativeError::new(
            "EINVALID_NAME",
            format!("“{name}” cannot be used as a local file name"),
        ));
    }
    Ok(name.to_string())
}

/// Enumerate a remote selection depth-first. Directory symlinks are not
/// followed (cycles); symlinks to files are transferred as files.
pub fn walk(
    files: &dyn RemoteFiles,
    provider: &str,
    path: &str,
    cancel: &AtomicBool,
) -> Result<Vec<TreeEntry>, NativeError> {
    let root = files.stat(provider, path)?;
    if root.is_directory && root.is_symbolic_link {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Links to folders cannot be transferred this way; open the folder and select its items",
        )
        .with_path(path));
    }
    let mut result = Vec::new();
    let mut pending = vec![(vec![safe_component(&root.name)?], root)];
    while let Some((relative, stat)) = pending.pop() {
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        if result.len() >= MAX_TREE_ENTRIES {
            return Err(NativeError::new(
                "ETOO_MANY_ITEMS",
                "The selection contains too many files for this transfer",
            ));
        }
        if stat.is_directory {
            let mut children = files.list(provider, &stat.path)?;
            children.sort_by(|a, b| b.name.cmp(&a.name));
            for child in children {
                if child.is_symbolic_link && child.is_directory {
                    continue;
                }
                let mut next = relative.clone();
                next.push(safe_component(&child.name)?);
                pending.push((next, child));
            }
        }
        result.push(TreeEntry {
            relative,
            remote_path: stat.path,
            is_directory: stat.is_directory,
            size: if stat.is_directory { 0 } else { stat.size },
            modified: stat.modified,
        });
    }
    Ok(result)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Copy with cancellation checkpoints between bounded chunks.
pub fn copy_stream(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<u64, NativeError> {
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut total = 0;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(NativeError::from_io(
                    &error,
                    "Unable to read the remote file",
                ))
            }
        };
        writer
            .write_all(&buffer[..read])
            .map_err(|error| NativeError::from_io(&error, "Unable to write the local file"))?;
        total += read as u64;
        on_bytes(read as u64);
    }
    writer
        .flush()
        .map_err(|error| NativeError::from_io(&error, "Unable to write the local file"))?;
    Ok(total)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Remove only what this transfer created.
struct CreatedPaths(Vec<PathBuf>, bool);
impl Drop for CreatedPaths {
    fn drop(&mut self) {
        if self.1 {
            return;
        }
        for path in self.0.iter().rev() {
            let _ = if path.is_dir() {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            };
        }
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Download one remote item to exactly `destination` (which must not exist).
/// A failure or cancellation removes the partial result; existing files are
/// never overwritten.
pub fn download(
    files: &dyn RemoteFiles,
    provider: &str,
    remote_path: &str,
    destination: &Path,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), NativeError> {
    let entries = walk(files, provider, remote_path, cancel)?;
    download_entries(files, provider, entries, destination, cancel, on_bytes)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Download an already enumerated tree (see [`walk`]) to `destination`.
pub fn download_entries(
    files: &dyn RemoteFiles,
    provider: &str,
    entries: Vec<TreeEntry>,
    destination: &Path,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), NativeError> {
    let mut created = CreatedPaths(Vec::new(), false);
    for entry in entries {
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let local = entry
            .relative
            .iter()
            .skip(1)
            .fold(destination.to_path_buf(), |path, part| path.join(part));
        if entry.is_directory {
            fs::create_dir(&local).map_err(|error| {
                NativeError::from_io(&error, "Unable to create the destination folder")
                    .with_path(&local)
            })?;
            created.0.push(local);
            continue;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&local)
            .map_err(|error| {
                NativeError::from_io(&error, "Unable to create the destination file")
                    .with_path(&local)
            })?;
        created.0.push(local.clone());
        let mut input = files.open(provider, &entry.remote_path)?;
        copy_stream(&mut input, &mut output, cancel, on_bytes)
            .map_err(|error| error.with_path(&entry.remote_path))?;
        if let Some(modified) = entry.modified {
            let _ =
                filetime::set_file_mtime(&local, filetime::FileTime::from_unix_time(modified, 0));
        }
    }
    created.1 = true;
    Ok(())
}

/// The SFTP provider as a streaming source. Uses the existing provider
/// connection (with its reconnect policy); no parallel SFTP implementation.
#[derive(Clone)]
pub struct SftpFiles(pub std::sync::Arc<crate::ssh::SshManager>);

impl RemoteFiles for SftpFiles {
    fn stat(&self, provider: &str, path: &str) -> Result<RemoteStat, NativeError> {
        self.0.remote_stat(provider, path)
    }

    fn list(&self, provider: &str, path: &str) -> Result<Vec<RemoteStat>, NativeError> {
        self.0.remote_children(provider, path)
    }

    fn open(&self, provider: &str, path: &str) -> Result<Box<dyn Read + Send>, NativeError> {
        Ok(Box::new(self.0.open_content_stream(provider, path)?))
    }
}

/// Dispatches on the provider id, so native shell objects can stream both
/// local files and SFTP files through one interface.
#[derive(Clone)]
pub struct ProviderFiles {
    pub sftp: SftpFiles,
}

fn local_stat(path: &Path) -> Result<RemoteStat, NativeError> {
    let link = fs::symlink_metadata(path)
        .map_err(|error| NativeError::from_io(&error, "The item is unavailable").with_path(path))?;
    let is_symbolic_link = link.file_type().is_symlink();
    let metadata = if is_symbolic_link {
        fs::metadata(path).unwrap_or(link)
    } else {
        link
    };
    Ok(RemoteStat {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        is_directory: metadata.is_dir(),
        is_symbolic_link,
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64),
    })
}

impl RemoteFiles for ProviderFiles {
    fn stat(&self, provider: &str, path: &str) -> Result<RemoteStat, NativeError> {
        if provider == "local" {
            local_stat(Path::new(path))
        } else {
            self.sftp.stat(provider, path)
        }
    }

    fn list(&self, provider: &str, path: &str) -> Result<Vec<RemoteStat>, NativeError> {
        if provider != "local" {
            return self.sftp.list(provider, path);
        }
        fs::read_dir(path)
            .map_err(|error| {
                NativeError::from_io(&error, "Unable to read the folder").with_path(path)
            })?
            .map(|entry| {
                let entry = entry
                    .map_err(|error| NativeError::from_io(&error, "Unable to read the folder"))?;
                local_stat(&entry.path())
            })
            .collect()
    }

    fn open(&self, provider: &str, path: &str) -> Result<Box<dyn Read + Send>, NativeError> {
        if provider != "local" {
            return self.sftp.open(provider, path);
        }
        Ok(Box::new(fs::File::open(path).map_err(|error| {
            NativeError::from_io(&error, "Unable to open the file").with_path(path)
        })?))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// In-memory provider used by transfer and staging tests.
    #[derive(Default)]
    pub struct MemoryFiles {
        pub entries: BTreeMap<String, (bool, Vec<u8>)>,
    }

    impl MemoryFiles {
        pub fn with(mut self, path: &str, content: Option<&[u8]>) -> Self {
            self.entries.insert(
                path.into(),
                (content.is_none(), content.unwrap_or_default().to_vec()),
            );
            self
        }
        fn stat_of(&self, path: &str) -> Option<RemoteStat> {
            let (directory, bytes) = self.entries.get(path)?;
            Some(RemoteStat {
                name: path.rsplit('/').next().unwrap().into(),
                path: path.into(),
                is_directory: *directory,
                is_symbolic_link: false,
                size: bytes.len() as u64,
                modified: Some(1_700_000_000),
            })
        }
    }

    impl RemoteFiles for MemoryFiles {
        fn stat(&self, _: &str, path: &str) -> Result<RemoteStat, NativeError> {
            self.stat_of(path)
                .ok_or_else(|| NativeError::new("ENOENT", "missing"))
        }
        fn list(&self, _: &str, path: &str) -> Result<Vec<RemoteStat>, NativeError> {
            let prefix = format!("{path}/");
            Ok(self
                .entries
                .keys()
                .filter(|key| key.starts_with(&prefix) && !key[prefix.len()..].contains('/'))
                .filter_map(|key| self.stat_of(key))
                .collect())
        }
        fn open(&self, _: &str, path: &str) -> Result<Box<dyn Read + Send>, NativeError> {
            let (_, bytes) = self
                .entries
                .get(path)
                .ok_or_else(|| NativeError::new("ENOENT", "missing"))?;
            Ok(Box::new(io::Cursor::new(bytes.clone())))
        }
    }

    pub fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("vesperwind-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn walks_and_downloads_a_remote_tree_in_chunks() {
        let big = vec![7u8; CHUNK_SIZE * 2 + 5];
        let files = MemoryFiles::default()
            .with("/srv/Папка", None)
            .with("/srv/Папка/a b.txt", Some(b"hello"))
            .with("/srv/Папка/nested", None)
            .with("/srv/Папка/nested/big.bin", Some(&big));
        let cancel = AtomicBool::new(false);
        let tree = walk(&files, "sftp:x", "/srv/Папка", &cancel).unwrap();
        assert_eq!(tree.len(), 4);
        assert_eq!(tree[0].relative, ["Папка"]);
        assert!(tree
            .iter()
            .any(|e| e.relative == ["Папка", "nested", "big.bin"]));

        let root = temp_dir("download");
        let mut chunks = 0;
        download(
            &files,
            "sftp:x",
            "/srv/Папка",
            &root.join("Папка"),
            &cancel,
            &mut |_| chunks += 1,
        )
        .unwrap();
        assert_eq!(fs::read(root.join("Папка/a b.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(root.join("Папка/nested/big.bin")).unwrap(), big);
        assert!(chunks >= 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_or_conflicting_download_leaves_no_partial_result() {
        let files = MemoryFiles::default()
            .with("/srv/d", None)
            .with("/srv/d/f", Some(b"data"));
        let root = temp_dir("cancel");
        let cancel = AtomicBool::new(true);
        assert_eq!(
            download(&files, "p", "/srv/d", &root.join("d"), &cancel, &mut |_| {})
                .unwrap_err()
                .code,
            "ECANCELLED"
        );
        assert!(!root.join("d").exists());

        fs::write(root.join("existing"), b"keep").unwrap();
        let files = MemoryFiles::default().with("/srv/existing", Some(b"remote"));
        let error = download(
            &files,
            "p",
            "/srv/existing",
            &root.join("existing"),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code, "EEXIST");
        assert_eq!(fs::read(root.join("existing")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_traversal_and_separator_names() {
        for name in ["..", ".", "a/b", "a\\b", "", "nul\0"] {
            assert_eq!(safe_component(name).unwrap_err().code, "EINVALID_NAME");
        }
        assert_eq!(
            safe_component("Отчёт 'v2' (final).txt").unwrap(),
            "Отчёт 'v2' (final).txt"
        );
        let files = MemoryFiles::default()
            .with("/srv/d", None)
            .with("/srv/d/..", Some(b"x"));
        assert_eq!(
            walk(&files, "p", "/srv/d", &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "EINVALID_NAME"
        );
    }
}
