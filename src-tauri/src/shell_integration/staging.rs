//! Managed staging for remote items that a platform can only paste as real
//! files (macOS Finder Paste needs file URLs). Each clipboard token owns one
//! directory: `<app cache>/clipboard-staging/<token>/<index>/<name>`. The
//! per-item index keeps equal names from different folders apart and keeps
//! each selected folder's hierarchy intact.
use super::transfer::{self, RemoteFiles};
use crate::error::NativeError;
#[cfg(test)]
use std::path::Path;
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};

/// Finder Paste of larger remote selections is not staged silently; file
/// promises (drag and drop) stream directly to the destination instead.
pub const MAX_STAGED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Staging {
    root: PathBuf,
}

/// Cleanup rule: delete every directory that this module created (named by a
/// UUID token) except the one the system clipboard still references. Names
/// that are not tokens are never touched.
pub fn stale_directories(names: &[String], referenced: Option<&str>) -> Vec<String> {
    names
        .iter()
        .filter(|name| uuid::Uuid::parse_str(name).is_ok())
        .filter(|name| Some(name.as_str()) != referenced)
        .cloned()
        .collect()
}

impl Staging {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn token_dir(&self, token: &str) -> Result<PathBuf, NativeError> {
        uuid::Uuid::parse_str(token)
            .map_err(|_| NativeError::new("EINVAL", "Invalid clipboard token"))?;
        Ok(self.root.join(token))
    }

    /// Remove stale staging data. Called at startup and whenever the system
    /// clipboard no longer references an older token.
    pub fn cleanup(&self, referenced: Option<&str>) {
        // Refuse to operate through a symlinked staging root.
        match fs::symlink_metadata(&self.root) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            _ => return,
        }
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        for name in stale_directories(&names, referenced) {
            let path = self.root.join(name);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            {
                let _ = crate::filesystem::operations::remove_bounded(&path);
            }
        }
    }

    /// Download `items` (provider, path) under a fresh directory for `token`
    /// and return the staged top-level paths in selection order.
    pub fn stage(
        &self,
        files: &dyn RemoteFiles,
        token: &str,
        items: &[(String, String)],
        cancel: &AtomicBool,
        on_bytes: &mut dyn FnMut(u64),
    ) -> Result<Vec<PathBuf>, NativeError> {
        let directory = self.token_dir(token)?;
        fs::create_dir_all(&directory).map_err(|error| {
            NativeError::from_io(&error, "Unable to create the staging folder")
                .with_path(&directory)
        })?;
        let mut staged = Vec::with_capacity(items.len());
        let result = (|| {
            for (index, (provider, path)) in items.iter().enumerate() {
                let stat = files.stat(provider, path)?;
                let name = transfer::safe_component(&stat.name)?;
                let parent = directory.join(index.to_string());
                fs::create_dir(&parent).map_err(|error| {
                    NativeError::from_io(&error, "Unable to create the staging folder")
                })?;
                let destination = parent.join(name);
                transfer::download(files, provider, path, &destination, cancel, on_bytes)?;
                staged.push(destination);
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = crate::filesystem::operations::remove_bounded(&directory);
            return Err(error);
        }
        Ok(staged)
    }

    /// Total size of a remote selection, so oversized staging is refused
    /// before any byte is downloaded.
    pub fn measure(
        files: &dyn RemoteFiles,
        items: &[(String, String)],
        cancel: &AtomicBool,
    ) -> Result<u64, NativeError> {
        let mut total = 0u64;
        for (provider, path) in items {
            for entry in transfer::walk(files, provider, path, cancel)? {
                total = total.saturating_add(entry.size);
            }
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_integration::transfer::tests::{temp_dir, MemoryFiles};

    #[test]
    fn cleanup_rule_keeps_the_referenced_token_and_foreign_names() {
        let keep = uuid::Uuid::new_v4().to_string();
        let old = uuid::Uuid::new_v4().to_string();
        let names = vec![keep.clone(), old.clone(), "user notes".into(), "..".into()];
        assert_eq!(
            stale_directories(&names, Some(&keep)),
            std::slice::from_ref(&old)
        );
        assert_eq!(stale_directories(&names, None), [keep, old]);
    }

    #[test]
    fn stages_equal_names_without_collisions_and_cleans_up() {
        let files = MemoryFiles::default()
            .with("/a/report.txt", Some(b"first"))
            .with("/b/report.txt", Some(b"second"))
            .with("/b/folder", None)
            .with("/b/folder/inner.txt", Some(b"inner"));
        let staging = Staging::new(temp_dir("staging"));
        let token = uuid::Uuid::new_v4().to_string();
        let items = vec![
            ("sftp:1".to_string(), "/a/report.txt".to_string()),
            ("sftp:1".to_string(), "/b/report.txt".to_string()),
            ("sftp:1".to_string(), "/b/folder".to_string()),
        ];
        let cancel = AtomicBool::new(false);
        assert_eq!(Staging::measure(&files, &items, &cancel).unwrap(), 16);
        let staged = staging
            .stage(&files, &token, &items, &cancel, &mut |_| {})
            .unwrap();
        assert_eq!(fs::read(&staged[0]).unwrap(), b"first");
        assert_eq!(fs::read(&staged[1]).unwrap(), b"second");
        assert_eq!(staged[0].file_name(), staged[1].file_name());
        assert_eq!(fs::read(staged[2].join("inner.txt")).unwrap(), b"inner");

        let other = uuid::Uuid::new_v4().to_string();
        fs::create_dir(staging.root().join(&other)).unwrap();
        fs::create_dir(staging.root().join("keep-me")).unwrap();
        staging.cleanup(Some(&token));
        assert!(staging.root().join(&token).exists());
        assert!(!staging.root().join(&other).exists());
        assert!(staging.root().join("keep-me").exists());
        staging.cleanup(None);
        assert!(!staging.root().join(&token).exists());
        fs::remove_dir_all(staging.root()).unwrap();
    }

    #[test]
    fn failed_staging_removes_the_token_directory() {
        let files = MemoryFiles::default().with("/a/ok.txt", Some(b"ok"));
        let staging = Staging::new(temp_dir("staging-fail"));
        let token = uuid::Uuid::new_v4().to_string();
        let items = vec![
            ("p".to_string(), "/a/ok.txt".to_string()),
            ("p".to_string(), "/a/missing.txt".to_string()),
        ];
        assert!(staging
            .stage(&files, &token, &items, &AtomicBool::new(false), &mut |_| {})
            .is_err());
        assert!(!staging.root().join(&token).exists());
        assert_eq!(
            staging
                .stage(
                    &files,
                    "../escape",
                    &items,
                    &AtomicBool::new(false),
                    &mut |_| {}
                )
                .unwrap_err()
                .code,
            "EINVAL"
        );
        fs::remove_dir_all(staging.root()).unwrap();
    }
}
