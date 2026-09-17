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
        paths::verify_existing_inside_root(self, &resolved)?;
        let reader = fs::read_dir(&resolved)
            .map_err(|error| filesystem_error(&error, requested, "Unable to read this folder"))?;
        let mut entries = Vec::new();

        for item in reader {
            let item = item.map_err(|error| {
                filesystem_error(&error, requested, "Unable to read this folder")
            })?;
            entries.push(entry_from_path(item.path(), item.file_name()));
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

fn entry_from_path(path: PathBuf, file_name: std::ffi::OsString) -> FileEntry {
    let name = file_name.to_string_lossy().into_owned();

    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            let is_directory = metadata.is_dir();
            FileEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                entry_type: if is_directory { "directory" } else { "file" },
                is_directory,
                is_symbolic_link: metadata.file_type().is_symlink(),
                size: (!is_directory).then_some(metadata.len()),
                modified_at: metadata.modified().ok().map(format_time),
                metadata_error: None,
            }
        }
        Err(error) => FileEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            entry_type: "file",
            is_directory: false,
            is_symbolic_link: false,
            size: None,
            modified_at: None,
            metadata_error: Some(MetadataError {
                code: NativeError::from_io(&error, "Unable to read metadata").code,
            }),
        },
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
