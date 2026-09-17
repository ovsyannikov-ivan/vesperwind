use super::{availability::require_content_ready, paths, Filesystem};
use crate::error::NativeError;
use filetime::FileTime;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    pub action: String,
    pub source_path: Option<String>,
    pub target_directory: Option<String>,
    pub name: Option<String>,
    pub filesystem_id: Option<String>,
    pub target_filesystem_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub action: String,
    pub source_path: Option<String>,
    pub target_directory: Option<String>,
    pub destination_path: Option<String>,
}

pub fn perform(
    filesystem: &Filesystem,
    request: OperationRequest,
) -> Result<OperationResult, NativeError> {
    Filesystem::require_local(request.filesystem_id.as_deref())?;
    if let Some(provider) = request.target_filesystem_id.as_deref() {
        Filesystem::require_local(Some(provider))?;
    }

    match request.action.as_str() {
        "create-file" | "create-folder" => create_entry(filesystem, request),
        "copy" | "move" | "link" | "delete" | "rename" => operate_existing(filesystem, request),
        _ => Err(NativeError::new("EINVAL", "Unknown file operation")),
    }
}

fn create_entry(
    filesystem: &Filesystem,
    request: OperationRequest,
) -> Result<OperationResult, NativeError> {
    let name = require_valid_name(request.name.as_deref())?;
    let target = request
        .target_directory
        .as_deref()
        .ok_or_else(|| NativeError::new("EINVAL", "A destination folder is required"))?;
    let parent = paths::resolve_inside_root(filesystem, target)?;
    paths::verify_existing_inside_root(filesystem, &parent)?;
    ensure_directory(&parent)?;
    let destination = paths::resolve_inside_root(filesystem, &parent.join(name).to_string_lossy())?;

    let result = if request.action == "create-folder" {
        fs::create_dir(&destination)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map(|_| ())
    };
    result.map_err(|error| operation_io_error(&error))?;

    Ok(operation_result(
        &request.action,
        None,
        Some(parent),
        Some(destination),
    ))
}

fn operate_existing(
    filesystem: &Filesystem,
    request: OperationRequest,
) -> Result<OperationResult, NativeError> {
    let source_text = request
        .source_path
        .as_deref()
        .ok_or_else(|| NativeError::new("EINVAL", "A source path is required"))?;
    let source = paths::resolve_inside_root(filesystem, source_text)?;

    if source == filesystem.root() {
        return Err(NativeError::new(
            "EROOT_OPERATION",
            "The configured filesystem root cannot be changed",
        ));
    }

    let source_metadata =
        fs::symlink_metadata(&source).map_err(|error| operation_io_error(&error))?;

    if request.action == "rename" {
        let name = require_valid_name(request.name.as_deref())?;
        let parent = source
            .parent()
            .ok_or_else(|| NativeError::new("EINVAL", "Invalid source path"))?
            .to_path_buf();
        paths::verify_existing_inside_root(filesystem, &parent)?;
        let destination =
            paths::resolve_inside_root(filesystem, &parent.join(name).to_string_lossy())?;
        if destination != source {
            ensure_available(&destination)?;
            fs::rename(&source, &destination).map_err(|error| operation_io_error(&error))?;
        }
        return Ok(operation_result(
            &request.action,
            Some(source),
            Some(parent),
            Some(destination),
        ));
    }

    if request.action == "delete" {
        let parent = source
            .parent()
            .ok_or_else(|| NativeError::new("EINVAL", "Invalid source path"))?;
        paths::verify_existing_inside_root(filesystem, parent)?;
        remove_entry(&source, &source_metadata).map_err(|error| operation_io_error(&error))?;
        return Ok(operation_result(&request.action, Some(source), None, None));
    }

    let target_text = request
        .target_directory
        .as_deref()
        .ok_or_else(|| NativeError::new("EINVAL", "A destination folder is required"))?;
    let target = paths::resolve_inside_root(filesystem, target_text)?;
    let real_source = paths::verify_existing_inside_root(filesystem, &source)?;
    let real_target = paths::verify_existing_inside_root(filesystem, &target)?;
    ensure_directory(&target)?;

    if source_metadata.is_dir() && real_target.starts_with(&real_source) {
        return Err(NativeError::new(
            "ECYCLE",
            "A folder cannot be copied or moved into itself",
        ));
    }

    let source_name = source
        .file_name()
        .ok_or_else(|| NativeError::new("EINVAL", "Invalid source path"))?;
    let destination =
        paths::resolve_inside_root(filesystem, &target.join(source_name).to_string_lossy())?;

    if destination == source {
        return Err(NativeError::new(
            "ESAMEPATH",
            "The item is already in this folder",
        ));
    }
    ensure_available(&destination)?;

    match request.action.as_str() {
        "copy" => {
            prepare_copy_content(filesystem, &source, &source_metadata)?;
            copy_entry(&source, &destination, &source_metadata)
                .map_err(|error| operation_io_error(&error))
        }
        "move" => move_entry(filesystem, &source, &destination, &source_metadata),
        "link" => create_relative_link(&source, &destination, &target, source_metadata.is_dir())
            .map_err(|error| operation_io_error(&error)),
        _ => unreachable!(),
    }
    .map_err(|error| {
        let _ = remove_partial(&destination);
        error
    })?;

    Ok(operation_result(
        &request.action,
        Some(source),
        Some(target),
        Some(destination),
    ))
}

fn require_valid_name(name: Option<&str>) -> Result<&str, NativeError> {
    let name = name.unwrap_or("");
    if name.trim().is_empty() || name == "." || name == ".." {
        return Err(NativeError::new(
            "EINVALID_NAME",
            "Enter a file or folder name",
        ));
    }
    if name
        .chars()
        .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err(NativeError::new(
            "EINVALID_NAME",
            "The name cannot contain slashes or control characters",
        ));
    }
    Ok(name)
}

fn ensure_directory(path: &Path) -> Result<(), NativeError> {
    if fs::metadata(path)
        .map_err(|error| operation_io_error(&error))?
        .is_dir()
    {
        Ok(())
    } else {
        Err(NativeError::new(
            "ENOTDIR",
            "The drop target is not a folder",
        ))
    }
}

fn ensure_available(path: &Path) -> Result<(), NativeError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(NativeError::new(
            "EEXIST",
            "An item with this name already exists in the destination folder",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(operation_io_error(&error)),
    }
}

fn copy_entry(source: &Path, destination: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        fs::set_permissions(destination, metadata.permissions())?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let child_metadata = fs::symlink_metadata(entry.path())?;
            copy_entry(
                &entry.path(),
                &destination.join(entry.file_name()),
                &child_metadata,
            )?;
        }
    } else {
        fs::copy(source, destination)?;
        fs::set_permissions(destination, metadata.permissions())?;
    }

    let accessed = FileTime::from_last_access_time(metadata);
    let modified = FileTime::from_last_modification_time(metadata);
    filetime::set_file_times(destination, accessed, modified)?;
    Ok(())
}

fn move_entry(
    filesystem: &Filesystem,
    source: &Path,
    destination: &Path,
    metadata: &fs::Metadata,
) -> Result<(), NativeError> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            prepare_copy_content(filesystem, source, metadata)?;
            copy_entry(source, destination, metadata)
                .map_err(|error| operation_io_error(&error))?;
            remove_entry(source, metadata).map_err(|error| operation_io_error(&error))
        }
        Err(error) => Err(operation_io_error(&error)),
    }
}

fn prepare_copy_content(
    filesystem: &Filesystem,
    source: &Path,
    metadata: &fs::Metadata,
) -> Result<(), NativeError> {
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        let mut pending = false;
        for entry in fs::read_dir(source).map_err(|error| operation_io_error(&error))? {
            let entry = entry.map_err(|error| operation_io_error(&error))?;
            let child_metadata =
                fs::symlink_metadata(entry.path()).map_err(|error| operation_io_error(&error))?;
            match prepare_copy_content(filesystem, &entry.path(), &child_metadata) {
                Err(error) if error.code == "ECONTENT_MATERIALIZING" => pending = true,
                result => result?,
            }
        }
        if pending {
            return Err(NativeError::new(
                "ECONTENT_MATERIALIZING",
                "One or more files are still being prepared. Retry the copy when preparation completes.",
            )
            .with_path(source));
        }
        return Ok(());
    }

    require_content_ready(filesystem, Some("local"), &source.to_string_lossy()).map(|_| ())
}

fn remove_entry(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn remove_partial(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => remove_entry(path, &metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn create_relative_link(
    source: &Path,
    destination: &Path,
    target_directory: &Path,
    is_directory: bool,
) -> io::Result<()> {
    let relative = relative_path(target_directory, source);
    create_symlink(&relative, destination, is_directory)
}

fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from_parts: Vec<_> = from.components().collect();
    let to_parts: Vec<_> = to.components().collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = PathBuf::new();
    for _ in common..from_parts.len() {
        result.push("..");
    }
    for part in &to_parts[common..] {
        result.push(part.as_os_str());
    }
    result
}

#[cfg(unix)]
fn create_symlink(target: &Path, destination: &Path, _is_directory: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(target, destination)
}

#[cfg(windows)]
fn create_symlink(target: &Path, destination: &Path, is_directory: bool) -> io::Result<()> {
    if is_directory {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    }
}

fn copy_symlink(source: &Path, destination: &Path) -> io::Result<()> {
    let target = fs::read_link(source)?;
    let is_directory = fs::metadata(source)
        .map(|value| value.is_dir())
        .unwrap_or(false);
    create_symlink(&target, destination, is_directory)
}

fn operation_io_error(error: &io::Error) -> NativeError {
    let mut result = NativeError::from_io(error, "The file operation failed");
    result.message = match result.code.as_str() {
        "EACCES" => "Permission denied",
        "ENOENT" => "The source or destination no longer exists",
        "ENOTDIR" => "The drop target is not a folder",
        "EEXIST" => "An item with this name already exists in the destination folder",
        _ => "The file operation failed",
    }
    .to_string();
    result
}

fn operation_result(
    action: &str,
    source: Option<PathBuf>,
    target: Option<PathBuf>,
    destination: Option<PathBuf>,
) -> OperationResult {
    OperationResult {
        action: action.to_string(),
        source_path: source.map(|value| value.to_string_lossy().into_owned()),
        target_directory: target.map(|value| value.to_string_lossy().into_owned()),
        destination_path: destination.map(|value| value.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{perform, relative_path, OperationRequest};
    use crate::filesystem::{paths, Filesystem};
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use uuid::Uuid;

    #[test]
    fn creates_relative_link_targets() {
        assert_eq!(
            relative_path(Path::new("/root/target"), Path::new("/root/source/file")),
            Path::new("../source/file")
        );
    }

    #[test]
    fn supports_mutations_and_blocks_symlink_escape() {
        let test_root = std::env::temp_dir().join(format!("vesperwind-fs-test-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("vesperwind-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(test_root.join("left")).unwrap();
        fs::create_dir_all(test_root.join("right")).unwrap();
        fs::create_dir_all(test_root.join("third")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let filesystem = Filesystem::from_root(&test_root, PathBuf::from("/home/test")).unwrap();

        let request = |action: &str,
                       source: Option<PathBuf>,
                       target: Option<PathBuf>,
                       name: Option<&str>| OperationRequest {
            action: action.to_string(),
            source_path: source.map(|value| value.to_string_lossy().into_owned()),
            target_directory: target.map(|value| value.to_string_lossy().into_owned()),
            name: name.map(str::to_string),
            filesystem_id: Some("local".to_string()),
            target_filesystem_id: Some("local".to_string()),
        };

        let created = perform(
            &filesystem,
            request(
                "create-file",
                None,
                Some(test_root.join("left")),
                Some("note.txt"),
            ),
        )
        .unwrap();
        fs::write(created.destination_path.unwrap(), "hello").unwrap();
        perform(
            &filesystem,
            request(
                "copy",
                Some(test_root.join("left/note.txt")),
                Some(test_root.join("right")),
                None,
            ),
        )
        .unwrap();
        perform(
            &filesystem,
            request(
                "move",
                Some(test_root.join("right/note.txt")),
                Some(test_root.join("third")),
                None,
            ),
        )
        .unwrap();
        perform(
            &filesystem,
            request(
                "link",
                Some(test_root.join("left/note.txt")),
                Some(test_root.join("right")),
                None,
            ),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(test_root.join("third/note.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            fs::read_to_string(test_root.join("right/note.txt")).unwrap(),
            "hello"
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, test_root.join("escape")).unwrap();
            let escaped = paths::resolve_inside_root(
                &filesystem,
                &test_root.join("escape/secret.txt").to_string_lossy(),
            )
            .unwrap();
            assert_eq!(
                paths::verify_existing_inside_root(&filesystem, &escaped)
                    .unwrap_err()
                    .code,
                "EOUTSIDE_ROOT"
            );
        }

        perform(
            &filesystem,
            request("delete", Some(test_root.join("left/note.txt")), None, None),
        )
        .unwrap();
        assert!(!test_root.join("left/note.txt").exists());
        let _ = fs::remove_dir_all(&test_root);
        let _ = fs::remove_dir_all(&outside);
    }
}
