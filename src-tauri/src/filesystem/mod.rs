pub mod alias;
pub mod archives;
pub mod availability;
pub mod jobs;
pub mod network;
pub mod operations;
pub mod paths;
pub mod properties;
pub mod remote_ops;
pub mod search;
pub mod size;
pub mod text;
pub mod watch;

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
    desktop: bool,
}

pub const COMPUTER_PATH: &str = "computer://";

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
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_availability: Option<availability::ContentAvailability>,
    #[cfg(target_os = "windows")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_sync: Option<availability::onedrive::CloudSync>,
}

#[derive(Debug, Serialize)]
pub struct MetadataError {
    pub code: String,
}

impl Filesystem {
    pub fn from_environment() -> Result<Self, NativeError> {
        let home = dirs::home_dir()
            .ok_or_else(|| NativeError::new("EHOME", "Unable to locate the home directory"))?;
        Self::desktop(home)
    }

    fn desktop(home: PathBuf) -> Result<Self, NativeError> {
        let initial = if cfg!(target_os = "linux") {
            PathBuf::from("/")
        } else {
            home.clone()
        };
        let mut filesystem = Self::from_root(initial, home)?;
        filesystem.desktop = true;
        Ok(filesystem)
    }

    pub fn is_desktop(&self) -> bool {
        self.desktop
    }

    pub fn is_computer_root(&self, requested: &str) -> bool {
        self.desktop && cfg!(target_os = "windows") && requested == COMPUTER_PATH
    }

    pub fn is_operation_root(&self, path: &Path) -> bool {
        (!self.desktop && path == self.root()) || path.parent().is_none()
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
            desktop: false,
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
        if self.desktop {
            if cfg!(target_os = "windows") {
                return Ok(directory_location("This PC", COMPUTER_PATH, "computer"));
            }
            return self.directory_entry(Path::new("/"));
        }
        self.directory_entry(&self.root)
    }

    pub fn initial_entry(&self) -> Result<FileEntry, NativeError> {
        if self.desktop && !cfg!(target_os = "macos") {
            return self.root_entry();
        }
        self.directory_entry(&self.root)
    }

    fn directory_entry(&self, directory: &Path) -> Result<FileEntry, NativeError> {
        let metadata = fs::metadata(directory)
            .map_err(|error| NativeError::from_io(&error, "Unable to load filesystem root"))?;
        let name = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| directory.to_string_lossy().into_owned());

        Ok(FileEntry {
            name,
            path: directory.to_string_lossy().into_owned(),
            entry_type: "directory",
            is_directory: true,
            is_symbolic_link: false,
            size: None,
            modified_at: metadata.modified().ok().map(format_time),
            metadata_error: None,
            #[cfg(target_os = "windows")]
            cloud_sync: None,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            content_availability: None,
        })
    }

    pub fn list_directory(&self, requested: &str) -> Result<Vec<FileEntry>, NativeError> {
        if self.is_computer_root(requested) {
            return logical_drives();
        }
        let resolved = paths::resolve_inside_root(self, requested)?;
        let real = paths::verify_existing_inside_root(self, &resolved)?;
        let metadata = fs::metadata(&real)
            .map_err(|error| filesystem_error(&error, requested, "Unable to read this folder"))?;
        if !metadata.is_dir() {
            return Err(
                NativeError::new("ENOTDIR", "This item is not a folder").with_path(requested)
            );
        }
        #[cfg(target_os = "windows")]
        let mut entries = availability::onedrive::native::list_directory(self, &real, &resolved)?;
        #[cfg(not(target_os = "windows"))]
        let mut entries = {
            let reader = fs::read_dir(&real).map_err(|error| {
                filesystem_error(&error, requested, "Unable to read this folder")
            })?;
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
            entries
        };

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

fn directory_location(name: &str, path: &str, kind: &'static str) -> FileEntry {
    FileEntry {
        name: name.to_owned(),
        path: path.to_owned(),
        entry_type: kind,
        is_directory: true,
        is_symbolic_link: false,
        size: None,
        modified_at: None,
        metadata_error: None,
        #[cfg(target_os = "windows")]
        cloud_sync: None,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        content_availability: None,
    }
}

#[cfg(target_os = "windows")]
fn logical_drives() -> Result<Vec<FileEntry>, NativeError> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err(NativeError::from_io(
            &std::io::Error::last_os_error(),
            "Unable to list drives",
        ));
    }
    Ok((0..26)
        .filter(|index| mask & (1 << index) != 0)
        .map(|index| {
            let drive = format!("{}:\\", char::from(b'A' + index as u8));
            directory_location(&drive, &drive, "drive")
        })
        .collect())
}

#[cfg(not(target_os = "windows"))]
fn logical_drives() -> Result<Vec<FileEntry>, NativeError> {
    Err(NativeError::new(
        "EINVAL",
        "This PC is only available on Windows",
    ))
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
    #[cfg(target_os = "macos")]
    if let Some(metadata) = link_metadata
        .as_ref()
        .ok()
        .filter(|metadata| is_finder_alias && availability::is_dataless(metadata))
    {
        // Resolving a dataless alias would read its bookmark content. Retain the
        // alias itself until an explicit open materializes it; listing is passive.
        return FileEntry {
            name,
            path: display_path.to_string_lossy().into_owned(),
            entry_type: "file",
            is_directory: false,
            is_symbolic_link: true,
            size: Some(metadata.len()),
            modified_at: metadata.modified().ok().map(format_time),
            metadata_error: None,
            #[cfg(target_os = "windows")]
            cloud_sync: None,
            content_availability: availability::inspect_content_availability(
                &physical_path,
                metadata,
            ),
        };
    }
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
                    #[cfg(target_os = "windows")]
                    cloud_sync: None,
                    #[cfg(target_os = "windows")]
                    content_availability: None,
                    #[cfg(target_os = "macos")]
                    content_availability: if metadata.is_file() {
                        availability::inspect_content_availability(&real, &metadata)
                    } else {
                        None
                    },
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
        #[cfg(target_os = "windows")]
        cloud_sync: None,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        content_availability: None,
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

#[cfg(test)]
mod desktop_tests {
    use super::operations::{perform, OperationRequest};
    use super::*;

    #[test]
    fn ordinary_local_entry_omits_availability_from_wire_format() {
        let directory =
            std::env::temp_dir().join(format!("vesperwind-entry-wire-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("local.txt"), b"local bytes").unwrap();
        let filesystem = Filesystem::from_root(&directory, directory.clone()).unwrap();
        let entries = filesystem
            .list_directory(&directory.to_string_lossy())
            .unwrap();
        let json = serde_json::to_value(&entries[0]).unwrap();
        assert!(json.get("contentAvailability").is_none());
        assert_eq!(json["name"], "local.txt");
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opt-in listing latency measurement, not a CI timing assertion"]
    fn measure_large_local_listing() {
        let directory =
            std::env::temp_dir().join(format!("vesperwind-list-latency-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        for index in 0..3000 {
            fs::write(directory.join(format!("file-{index:04}.txt")), b"local").unwrap();
        }
        let filesystem = Filesystem::desktop(dirs::home_dir().unwrap()).unwrap();
        for iteration in 0..3 {
            let started = std::time::Instant::now();
            let entries = filesystem
                .list_directory(&directory.to_string_lossy())
                .unwrap();
            eprintln!(
                "listing_latency iteration={iteration} entries={} elapsed_ms={}",
                entries.len(),
                started.elapsed().as_millis()
            );
            assert_eq!(entries.len(), 3000);
            assert!(entries
                .iter()
                .all(|entry| entry.content_availability.is_none()));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_can_list_read_and_create_outside_initial_folder() {
        let fixture =
            std::env::temp_dir().join(format!("vesperwind-desktop-fs-{}", uuid::Uuid::new_v4()));
        let home = fixture.join("home");
        let outside = fixture.join("outside");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sample.txt"), b"outside home").unwrap();
        let confined = Filesystem::from_root(&home, home.clone()).unwrap();
        assert_eq!(
            confined
                .list_directory(&outside.to_string_lossy())
                .unwrap_err()
                .code,
            "EOUTSIDE_ROOT"
        );
        let desktop = Filesystem::desktop(home).unwrap();
        let entries = desktop.list_directory(&outside.to_string_lossy()).unwrap();
        assert_eq!(entries[0].name, "sample.txt");
        let resolved = paths::resolve_inside_root(&desktop, &entries[0].path).unwrap();
        let real = paths::verify_existing_inside_root(&desktop, &resolved).unwrap();
        assert_eq!(fs::read(real).unwrap(), b"outside home");
        perform(
            &desktop,
            OperationRequest {
                operation_id: None,
                timeout_ms: None,
                action: "create-file".into(),
                source_path: None,
                target_directory: Some(outside.to_string_lossy().into()),
                name: Some("new.txt".into()),
                filesystem_id: None,
                target_filesystem_id: None,
            },
        )
        .unwrap();
        assert!(outside.join("new.txt").is_file());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn desktop_navigation_root_and_initial_location_follow_platform() {
        let home = dirs::home_dir().unwrap();
        let desktop = Filesystem::desktop(home.clone()).unwrap();
        let root = desktop.root_entry().unwrap();
        let initial = desktop.initial_entry().unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!(root.path, COMPUTER_PATH);
            assert_eq!(initial.path, COMPUTER_PATH);
            let drives = desktop.list_directory(COMPUTER_PATH).unwrap();
            assert!(!drives.is_empty());
            assert!(drives
                .iter()
                .all(|entry| entry.is_directory && entry.entry_type == "drive"));
            let drive = Path::new(&drives[0].path);
            assert!(desktop.is_operation_root(drive));
        } else {
            assert_eq!(root.path, "/");
            assert_eq!(
                initial.path,
                if cfg!(target_os = "macos") {
                    home.to_string_lossy().into_owned()
                } else {
                    "/".into()
                }
            );
            assert!(desktop.is_operation_root(Path::new("/")));
        }
        assert_eq!(
            paths::resolve_inside_root(&desktop, COMPUTER_PATH)
                .unwrap_err()
                .code,
            "EINVAL"
        );
    }
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
