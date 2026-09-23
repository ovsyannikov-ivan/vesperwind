pub mod alias;
pub mod availability;
pub mod operations;
pub mod paths;

use crate::error::NativeError;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Debug)]
pub struct Filesystem {
    root: PathBuf,
    real_root: PathBuf,
    home: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    pub metadata_error: Option<MetadataError>,
}

#[derive(Debug, Serialize)]
pub struct MetadataError {
    pub code: String,
}

impl Filesystem {
    pub fn from_environment() -> Result<Self, NativeError> {
        let home = dirs::home_dir()
            .ok_or_else(|| NativeError::new("EHOME", "Unable to locate the home directory"))?;
        let configured = std::env::var("FILE_MANAGER_ROOT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.clone());
        Self::from_root(configured, home)
    }

    pub(crate) fn from_root(
        configured: impl AsRef<Path>,
        home: PathBuf,
    ) -> Result<Self, NativeError> {
        let root = paths::absolute_clean(configured.as_ref())?;
        let metadata = fs::metadata(&root)
            .map_err(|error| NativeError::from_io(&error, "Unable to open FILE_MANAGER_ROOT"))?;

        if !metadata.is_dir() {
            return Err(NativeError::new(
                "ENOTDIR",
                "FILE_MANAGER_ROOT must point to a directory",
            ));
        }

        let real_root = fs::canonicalize(&root)
            .map_err(|error| NativeError::from_io(&error, "Unable to open FILE_MANAGER_ROOT"))?;

        Ok(Self {
            root,
            real_root,
            home,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn real_root(&self) -> &Path {
        &self.real_root
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn require_local(provider_id: Option<&str>) -> Result<(), NativeError> {
        if provider_id.unwrap_or("local") == "local" {
            Ok(())
        } else {
            Err(NativeError::new(
                "EFILESYSTEM_ID",
                "This filesystem is not available",
            ))
        }
    }

    pub fn root_entry(&self) -> Result<FileEntry, NativeError> {
        let metadata = fs::metadata(&self.root)
            .map_err(|error| NativeError::from_io(&error, "Unable to load filesystem root"))?;
        let name = self
            .root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.to_string_lossy().into_owned());

        Ok(FileEntry {
            name,
            path: self.root.to_string_lossy().into_owned(),
            entry_type: "directory",
            is_directory: true,
            is_symbolic_link: false,
            size: None,
            modified_at: metadata.modified().ok().map(format_time),
            metadata_error: None,
        })
    }

    pub fn list_directory(&self, requested: &str) -> Result<Vec<FileEntry>, NativeError> {
        let resolved = paths::resolve_inside_root(self, requested)?;
        let real = paths::verify_existing_inside_root(self, &resolved)?;
        let metadata = fs::metadata(&real)
            .map_err(|error| filesystem_error(&error, requested, "Unable to read this folder"))?;
        if !metadata.is_dir() {
            return Err(
                NativeError::new("ENOTDIR", "This item is not a folder").with_path(requested)
            );
        }
        let reader = fs::read_dir(&real)
            .map_err(|error| filesystem_error(&error, requested, "Unable to read this folder"))?;
        let mut entries = Vec::new();

        for item in reader {
            let item = item.map_err(|error| {
                filesystem_error(&error, requested, "Unable to read this folder")
            })?;
            entries.push(entry_from_path(
                self,
                item.path(),
                resolved.join(item.file_name()),
                item.file_name(),
            ));
        }

        entries.sort_by(
            |left, right| match (left.is_directory, right.is_directory) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
            },
        );
        Ok(entries)
    }
}

fn entry_from_path(
    filesystem: &Filesystem,
    physical_path: PathBuf,
    display_path: PathBuf,
    file_name: std::ffi::OsString,
) -> FileEntry {
    let name = file_name.to_string_lossy().into_owned();
    let link_metadata = fs::symlink_metadata(&physical_path);
    let is_finder_alias = alias::is_finder_alias(&physical_path).unwrap_or(false);
    let resolved = paths::verify_existing_inside_root(filesystem, &physical_path);

    match (link_metadata, resolved) {
        (Ok(link_metadata), Ok(real)) => match fs::metadata(&real) {
            Ok(metadata) => {
                let is_directory = metadata.is_dir();
                FileEntry {
                    name,
                    path: display_path.to_string_lossy().into_owned(),
                    entry_type: if is_directory { "directory" } else { "file" },
                    is_directory,
                    is_symbolic_link: link_metadata.file_type().is_symlink() || is_finder_alias,
                    size: (!is_directory).then_some(metadata.len()),
                    modified_at: metadata.modified().ok().map(format_time),
                    metadata_error: None,
                }
            }
            Err(error) => metadata_error_entry(
                name,
                display_path,
                NativeError::from_io(&error, "Unable to read metadata"),
            ),
        },
        (Err(error), _) => metadata_error_entry(
            name,
            display_path,
            NativeError::from_io(&error, "Unable to read metadata"),
        ),
        (_, Err(error)) => metadata_error_entry(name, display_path, error),
    }
}

fn metadata_error_entry(name: String, path: PathBuf, error: NativeError) -> FileEntry {
    FileEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        entry_type: "file",
        is_directory: false,
        is_symbolic_link: false,
        size: None,
        modified_at: None,
        metadata_error: Some(MetadataError { code: error.code }),
    }
}

pub fn format_time(time: SystemTime) -> String {
    let value: DateTime<Utc> = time.into();
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn filesystem_error(error: &std::io::Error, path: &str, fallback: &str) -> NativeError {
    let mut result = NativeError::from_io(error, fallback).with_path(path);
    result.message = match result.code.as_str() {
        "EACCES" => "Permission denied",
        "ENOENT" => "Folder no longer exists",
        "ENOTDIR" => "This item is not a folder",
        _ => fallback,
    }
    .to_string();
    result
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::Filesystem;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn create_finder_alias(target: &std::path::Path, alias: &std::path::Path) {
        use objc2_foundation::{
            NSString, NSURLBookmarkCreationOptions, NSURLBookmarkFileCreationOptions, NSURL,
        };
        let file_url = |path: &std::path::Path| {
            NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
        };
        let data = file_url(target)
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
                None,
                None,
            )
            .unwrap();
        NSURL::writeBookmarkData_toURL_options_error(
            &data,
            &file_url(alias),
            NSURLBookmarkFileCreationOptions::default(),
        )
        .unwrap();
    }

    #[test]
    fn navigates_directory_alias_with_logical_child_paths() {
        let root = std::env::temp_dir().join(format!("vesperwind-dir-alias-{}", Uuid::new_v4()));
        let target = root.join("real-folder");
        let alias = root.join("Folder alias");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("note.txt"), b"hello").unwrap();
        create_finder_alias(&target, &alias);
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();

        let parent_entry = filesystem
            .list_directory(&root.to_string_lossy())
            .unwrap()
            .into_iter()
            .find(|entry| entry.path == alias.to_string_lossy())
            .unwrap();
        assert!(parent_entry.is_directory);
        assert!(parent_entry.is_symbolic_link);

        let child = filesystem
            .list_directory(&alias.to_string_lossy())
            .unwrap()
            .into_iter()
            .find(|entry| entry.name == "note.txt")
            .unwrap();
        assert_eq!(child.path, alias.join("note.txt").to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn listing_preserves_real_finder_alias_path_and_uses_target_metadata() {
        let Some(path) = std::env::var_os("VESPERWIND_FINDER_ALIAS_TEST_PATH") else {
            return;
        };
        let alias = PathBuf::from(path);
        let parent = alias.parent().unwrap();
        let root = dirs::home_dir().unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let entries = filesystem
            .list_directory(&parent.to_string_lossy())
            .unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry.path == alias.to_string_lossy())
            .expect("Finder Alias entry");

        assert!(entry.is_symbolic_link);
        assert!(!entry.is_directory);
        assert!(entry.size.unwrap() > fs::metadata(alias).unwrap().len());
    }
}
