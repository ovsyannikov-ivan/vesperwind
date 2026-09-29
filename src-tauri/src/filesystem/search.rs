use super::{alias, Filesystem};
use crate::{error::NativeError, ssh::SshManager};
use serde::Serialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub const MAX_RESULTS: usize = 10_000;
const BATCH_SIZE: usize = 25;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub count: usize,
    pub limited: bool,
    pub cancelled: bool,
}

fn wildcard(pattern: &[char], value: &[char]) -> bool {
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for token in pattern {
        let mut next = vec![false; value.len() + 1];
        if *token == '*' {
            next[0] = previous[0];
        }
        for index in 1..=value.len() {
            next[index] = match token {
                '*' => previous[index] || next[index - 1],
                '?' => previous[index - 1],
                character => previous[index - 1] && *character == value[index - 1],
            };
        }
        previous = next;
    }
    previous[value.len()]
}

pub fn matches_query(name: &str, relative: &str, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return false;
    }
    let candidates = [name.to_lowercase(), relative.to_lowercase()];
    if !query.contains(['*', '?']) {
        return candidates.iter().any(|value| value.contains(&query));
    }
    let pattern: Vec<char> = query.chars().collect();
    candidates
        .iter()
        .any(|value| wildcard(&pattern, &value.chars().collect::<Vec<_>>()))
}

fn skip_error(error: &NativeError) -> bool {
    matches!(
        error.code.as_str(),
        "EACCES" | "EPERM" | "ENOENT" | "ENOTDIR" | "EOUTSIDE_ROOT"
    )
}

pub fn search<F>(
    filesystem: &Filesystem,
    ssh: &Arc<SshManager>,
    provider_id: &str,
    base_path: &str,
    query: &str,
    kind: &str,
    max_results: usize,
    hidden_suffixes: &[String],
    cancelled: &AtomicBool,
    mut on_batch: F,
) -> Result<SearchOutcome, NativeError>
where
    F: FnMut(Vec<SearchEntry>),
{
    if !matches!(kind, "all" | "files" | "folders") || query.trim().is_empty() {
        return Err(NativeError::new("EINVAL", "Invalid search request"));
    }
    if provider_id == "local" {
        let resolved = super::paths::resolve_inside_root(filesystem, base_path)?;
        super::paths::verify_existing_inside_root(filesystem, &resolved)?;
    } else {
        // The provider's list method validates its configured root.
        ssh.list(provider_id, base_path)?;
    }
    let mut pending = vec![base_path.to_owned()];
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut count = 0;
    let mut limited = false;
    while let Some(directory) = pending.pop() {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let entries = if provider_id == "local" {
            filesystem.list_directory(&directory)
        } else {
            ssh.list(provider_id, &directory)
        };
        let entries = match entries {
            Ok(value) => value,
            Err(error) if skip_error(&error) => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            let is_alias = provider_id == "local"
                && alias::is_finder_alias(Path::new(&entry.path)).unwrap_or(false);
            let is_directory = entry.is_directory && !entry.is_symbolic_link && !is_alias;
            if is_directory {
                pending.push(entry.path.clone());
            }
            if hidden_suffixes
                .iter()
                .any(|suffix| entry.name.to_lowercase().ends_with(&suffix.to_lowercase()))
            {
                continue;
            }
            if (kind == "files" && entry.is_directory) || (kind == "folders" && !entry.is_directory)
            {
                continue;
            }
            let relative = if provider_id == "local" {
                Path::new(&entry.path)
                    .strip_prefix(base_path)
                    .unwrap_or(Path::new(&entry.name))
                    .to_string_lossy()
                    .into_owned()
            } else {
                entry
                    .path
                    .strip_prefix(base_path.trim_end_matches('/'))
                    .unwrap_or(&entry.path)
                    .trim_start_matches('/')
                    .to_owned()
            };
            if !matches_query(&entry.name, &relative, query) {
                continue;
            }
            if count >= max_results.min(MAX_RESULTS).max(1) {
                limited = true;
                break;
            }
            batch.push(SearchEntry {
                name: entry.name,
                path: entry.path,
                relative_path: relative,
                entry_type: if is_directory { "directory" } else { "file" },
                is_directory,
                is_symbolic_link: entry.is_symbolic_link,
                size: entry.size,
                modified_at: entry.modified_at,
            });
            count += 1;
            if batch.len() >= BATCH_SIZE {
                on_batch(std::mem::take(&mut batch));
            }
        }
        if limited {
            break;
        }
    }
    if !batch.is_empty() {
        on_batch(batch);
    }
    Ok(SearchOutcome {
        count,
        limited,
        cancelled: cancelled.load(Ordering::Acquire),
    })
}

#[cfg(test)]
mod tests {
    use super::matches_query;
    #[test]
    fn recursive_search_batches_limits_and_respects_root() {
        use crate::{filesystem::Filesystem, ssh::SshManager};
        use std::{
            fs,
            sync::atomic::{AtomicBool, Ordering},
        };
        let root = std::env::temp_dir().join(format!("vesperwind-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested folder")).unwrap();
        for index in 0..60 {
            fs::write(
                root.join("nested folder").join(format!("item-{index}.txt")),
                "",
            )
            .unwrap();
        }
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let ssh = SshManager::new();
        let cancelled = AtomicBool::new(false);
        let mut batches = Vec::new();
        let outcome = super::search(
            &filesystem,
            &ssh,
            "local",
            &root.to_string_lossy(),
            "*.txt",
            "files",
            30,
            &[],
            &cancelled,
            |batch| batches.push(batch.len()),
        )
        .unwrap();
        assert_eq!(outcome.count, 30);
        assert!(outcome.limited);
        assert_eq!(batches.iter().sum::<usize>(), 30);
        assert!(batches.len() >= 2);
        let outside = super::search(
            &filesystem,
            &ssh,
            "local",
            &std::env::temp_dir().to_string_lossy(),
            "*.txt",
            "all",
            100,
            &[],
            &cancelled,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(outside.code, "EOUTSIDE_ROOT");
        cancelled.store(true, Ordering::Release);
        let stopped = super::search(
            &filesystem,
            &ssh,
            "local",
            &root.to_string_lossy(),
            "*.txt",
            "all",
            100,
            &[],
            &cancelled,
            |_| {},
        )
        .unwrap();
        assert!(stopped.cancelled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_query_matching() {
        assert!(matches_query("App.vue", "src/App.vue", "*.vue"));
        assert!(matches_query(
            "report-12.pdf",
            "docs/report-12.pdf",
            "report-??.pdf"
        ));
        assert!(matches_query("Привет.txt", "dir/Привет.txt", "прив"));
        assert!(!matches_query("App.vue", "src/App.vue", "*.js"));
    }
}
