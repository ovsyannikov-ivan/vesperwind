//! File operations that involve at least one remote provider. They run in
//! the filesystem helper, against the connections it opened from its private
//! stdin snapshot. A protocol supplies an endpoint; ordering, naming, cycle
//! checks and move semantics stay identical for every protocol.
use super::{
    operations::{OperationRequest, OperationResult},
    paths, Filesystem,
};
use crate::{
    error::NativeError,
    remote::{parse_provider, ProviderRef},
};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::Arc,
};

/// The protocol-specific primitives used by remote file operations. Paths
/// passed to every method except `resolve` and `remove` are already resolved.
pub trait RemoteEndpoint {
    /// Normalizes a requested path and confines it to the connection root.
    fn resolve(&self, requested: &str) -> Result<String, NativeError>;
    /// Type of the entry itself; a link is never followed.
    fn is_directory(&self, path: &str) -> Result<bool, NativeError>;
    /// Child names without `.` and `..`.
    fn child_names(&self, path: &str) -> Result<Vec<String>, NativeError>;
    fn open_read(&self, path: &str) -> Result<Box<dyn TransferRead + '_>, NativeError>;
    /// Creates a new file; an existing entry is an error, never overwritten.
    fn create_new(&self, path: &str) -> Result<Box<dyn TransferWrite + '_>, NativeError>;
    fn create_folder(&self, path: &str) -> Result<(), NativeError>;
    fn rename(&self, from: &str, to: &str) -> Result<(), NativeError>;
    /// Recursively removes a requested path.
    fn remove(&self, requested: &str) -> Result<(), NativeError>;
}

/// A download. `finish` completes the protocol transfer after end-of-file
/// (for FTP: the server's final reply) and reports its outcome.
pub trait TransferRead: Read {
    fn finish(self: Box<Self>) -> Result<(), NativeError>;
}

/// An upload. Success exists only after `finish` confirmed the transfer;
/// `abort` (or dropping the writer) never reports success.
pub trait TransferWrite: Write {
    fn finish(self: Box<Self>) -> Result<(), NativeError>;
    fn abort(self: Box<Self>) {}
}

/// Local files have no protocol completion beyond writing all bytes.
struct LocalRead(fs::File);
impl Read for LocalRead {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}
impl TransferRead for LocalRead {
    fn finish(self: Box<Self>) -> Result<(), NativeError> {
        Ok(())
    }
}
struct LocalWrite(fs::File);
impl Write for LocalWrite {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}
impl TransferWrite for LocalWrite {
    fn finish(mut self: Box<Self>) -> Result<(), NativeError> {
        self.0
            .flush()
            .map_err(|e| NativeError::from_io(&e, "The file transfer failed"))
    }
}

/// Bytes per read/write step of a transfer; between steps the deadline and
/// cancellation are checked and progress is reported.
pub const TRANSFER_CHUNK: usize = 256 * 1024;

fn transfer_io_error(error: &std::io::Error) -> NativeError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        NativeError::new(
            "ETIMEDOUT",
            "The remote server stopped responding during the transfer",
        )
        .with_native_error(error.to_string())
    } else {
        NativeError::from_io(error, "The file transfer failed")
    }
}

/// Copies one file in bounded chunks. Success needs end-of-file on the
/// source and completion of both transfers; otherwise the writer is aborted.
fn copy_stream(
    mut reader: Box<dyn TransferRead + '_>,
    mut writer: Box<dyn TransferWrite + '_>,
) -> Result<u64, NativeError> {
    let mut buffer = vec![0u8; TRANSFER_CHUNK];
    let mut total = 0u64;
    let copied = (|| loop {
        super::jobs::checkpoint()?;
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(transfer_io_error(&e)),
        };
        super::jobs::checkpoint()?;
        writer
            .write_all(&buffer[..read])
            .map_err(|e| transfer_io_error(&e))?;
        total += read as u64;
        super::jobs::report_progress(read as u64);
    })();
    if let Err(error) = copied {
        writer.abort();
        return Err(error);
    }
    if let Err(error) = reader.finish() {
        writer.abort();
        return Err(error);
    }
    writer.finish()?;
    Ok(total)
}

/// The helper's open remote connections, looked up by provider id.
pub trait RemoteSessions {
    fn endpoint(&self, provider_id: &str) -> Result<Arc<dyn RemoteEndpoint>, NativeError>;
}

fn remote_endpoint(
    sessions: &dyn RemoteSessions,
    provider_id: Option<&str>,
) -> Result<Option<Arc<dyn RemoteEndpoint>>, NativeError> {
    match parse_provider(provider_id)? {
        ProviderRef::Local => Ok(None),
        ProviderRef::Remote { .. } => sessions.endpoint(provider_id.unwrap_or("")).map(Some),
    }
}

pub(crate) fn remote_join(a: &str, b: &str) -> String {
    format!("{}/{}", a.trim_end_matches('/'), b.trim_matches('/'))
}
pub(crate) fn remote_parent(value: &str) -> String {
    value
        .rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or("/")
        .to_string()
}
pub(crate) fn remote_name(value: &str) -> &str {
    value
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|v| !v.is_empty())
        .unwrap_or("/")
}
/// A directory entry name reported by a remote server (MLSD, LIST, SFTP
/// readdir) or the local filesystem. It names one item and is never a path:
/// empty names, `.`, `..`, `/`, `\`, NUL and other control characters are
/// refused. Unicode and spaces are kept as they are.
pub fn validate_entry_name(name: &str) -> Result<(), NativeError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 1024
        || name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(NativeError::new(
            "EUNSAFE_NAME",
            "The server listed an unsafe file name; the operation was stopped",
        ));
    }
    Ok(())
}

/// The local path of one child of `directory`. Beyond `validate_entry_name`
/// it applies the local platform's rules (on Windows: drive and stream
/// separators, reserved characters, trailing dots and spaces) and checks
/// that the result is a direct child of `directory`.
fn local_child(directory: &str, name: &str) -> Result<String, NativeError> {
    validate_entry_name(name)?;
    crate::shell_integration::transfer::safe_component(name)?;
    let child = Path::new(directory).join(name);
    if child.parent() != Some(Path::new(directory))
        || child.file_name() != Some(std::ffi::OsStr::new(name))
    {
        return Err(NativeError::new(
            "EUNSAFE_NAME",
            "The server listed an unsafe file name; the operation was stopped",
        ));
    }
    Ok(child.to_string_lossy().into_owned())
}

pub(crate) fn validate_name(value: Option<&str>) -> Result<(), NativeError> {
    let value = value.unwrap_or("");
    if value.trim().is_empty()
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        Err(NativeError::new(
            "EINVALID_NAME",
            "Invalid file or folder name",
        ))
    } else {
        Ok(())
    }
}

fn operation_result(
    action: &str,
    source: Option<String>,
    target: Option<String>,
    destination: Option<String>,
) -> OperationResult {
    OperationResult {
        action: action.to_string(),
        source_path: source,
        target_directory: target,
        destination_path: destination,
    }
}

fn required_remote(
    endpoint: Option<&Arc<dyn RemoteEndpoint>>,
) -> Result<&Arc<dyn RemoteEndpoint>, NativeError> {
    endpoint.ok_or_else(crate::remote::unavailable)
}

pub fn operate(
    filesystem: &Filesystem,
    sessions: &dyn RemoteSessions,
    request: OperationRequest,
) -> Result<OperationResult, NativeError> {
    let source_provider = request.filesystem_id.as_deref();
    let target_provider = request.target_filesystem_id.as_deref();
    if request.action == "create-file" || request.action == "create-folder" {
        validate_name(request.name.as_deref())?;
        let target = required_remote(remote_endpoint(sessions, target_provider)?.as_ref())?.clone();
        let directory = request
            .target_directory
            .as_deref()
            .ok_or_else(|| NativeError::new("EINVAL", "A destination folder is required"))?;
        let destination = target.resolve(&remote_join(
            directory,
            request.name.as_deref().unwrap_or(""),
        ))?;
        if request.action == "create-folder" {
            target.create_folder(&destination)?;
        } else {
            target.create_new(&destination)?.finish()?;
        }
        return Ok(operation_result(
            &request.action,
            None,
            Some(directory.to_string()),
            Some(destination),
        ));
    }
    let source_path = request
        .source_path
        .as_deref()
        .ok_or_else(|| NativeError::new("EINVAL", "A source path is required"))?;
    let source_connection = remote_endpoint(sessions, source_provider)?;
    if request.action == "delete" {
        required_remote(source_connection.as_ref())?.remove(source_path)?;
        return Ok(operation_result(
            "delete",
            Some(source_path.to_string()),
            None,
            None,
        ));
    }
    if request.action == "rename" {
        validate_name(request.name.as_deref())?;
        let connection = required_remote(source_connection.as_ref())?;
        let source = connection.resolve(source_path)?;
        let destination = connection.resolve(&remote_join(
            &remote_parent(&source),
            request.name.as_deref().unwrap_or(""),
        ))?;
        connection.rename(&source, &destination)?;
        return Ok(operation_result(
            "rename",
            Some(source),
            Some(remote_parent(source_path)),
            Some(destination),
        ));
    }
    if request.action == "link" {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Symbolic links are not available for cross-provider operations",
        ));
    }
    let target_directory = request
        .target_directory
        .as_deref()
        .ok_or_else(|| NativeError::new("EINVAL", "A destination folder is required"))?;
    let target_connection = remote_endpoint(sessions, target_provider)?;
    let copy_name = if request.action == "copy" && request.name.is_some() {
        validate_name(request.name.as_deref())?;
        request.name.as_deref()
    } else {
        None
    };
    let source_name = if let Some(name) = copy_name {
        name
    } else if source_connection.is_some() {
        remote_name(source_path)
    } else {
        Path::new(source_path)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("")
    };
    let destination = if let Some(target) = target_connection.as_ref() {
        target.resolve(&remote_join(target_directory, source_name))?
    } else {
        let target = paths::resolve_inside_root(filesystem, target_directory)?;
        let target = paths::verify_existing_inside_root(filesystem, &target)?;
        // The selected item (or its Copy As name) follows the same local
        // name rules as recursive children: on Windows a drive-relative
        // `C:name` or an NTFS stream `name:stream` is refused.
        let child = local_child(&target.to_string_lossy(), source_name)?;
        paths::resolve_inside_root(filesystem, &child)?
            .to_string_lossy()
            .into_owned()
    };
    // Both sides are the same remote connection only when the ids are equal.
    let same_remote = source_connection.is_some() && source_provider == target_provider;
    if same_remote {
        let connection = source_connection.as_ref().unwrap();
        let source = connection.resolve(source_path)?;
        if source == destination {
            return Err(NativeError::new(
                "ESAMEPATH",
                "The item is already in this folder",
            ));
        }
        if connection.is_directory(&source)?
            && destination.starts_with(&(source.trim_end_matches('/').to_string() + "/"))
        {
            return Err(NativeError::new(
                "ECYCLE",
                "A folder cannot be copied or moved into itself",
            ));
        }
    }
    if request.action == "move" && same_remote {
        let connection = source_connection.as_ref().unwrap();
        let source = connection.resolve(source_path)?;
        connection.rename(&source, &destination)?;
    } else {
        copy_entry(
            filesystem,
            source_connection.as_deref(),
            source_path,
            target_connection.as_deref(),
            &destination,
        )?;
        if request.action == "move" {
            // The source is removed only after the whole copy succeeded.
            let removal = if let Some(source) = source_connection.as_ref() {
                source.remove(source_path)
            } else {
                let resolved = paths::resolve_inside_root(filesystem, source_path)?;
                paths::verify_existing_inside_root(filesystem, &resolved)?;
                if resolved.is_dir() {
                    fs::remove_dir_all(resolved)
                } else {
                    fs::remove_file(resolved)
                }
                .map_err(|e| NativeError::from_io(&e, "Unable to remove the copied source"))
            };
            if removal.is_err() {
                return Err(NativeError::new(
                    "EPARTIAL_MOVE",
                    format!(
                        "The copy completed at {destination}, but the source could not be removed"
                    ),
                ));
            }
        }
    }
    Ok(operation_result(
        &request.action,
        Some(source_path.to_string()),
        Some(target_directory.to_string()),
        Some(destination),
    ))
}

pub fn copy_entry(
    filesystem: &Filesystem,
    source_remote: Option<&dyn RemoteEndpoint>,
    source: &str,
    target_remote: Option<&dyn RemoteEndpoint>,
    destination: &str,
) -> Result<(), NativeError> {
    super::jobs::checkpoint()?;
    let resolved_source = if let Some(remote) = source_remote {
        remote.resolve(source)?
    } else {
        let local = paths::resolve_inside_root(filesystem, source)?;
        paths::verify_existing_inside_root(filesystem, &local)?
            .to_string_lossy()
            .into_owned()
    };
    let directory = if let Some(remote) = source_remote {
        remote.is_directory(&resolved_source)?
    } else {
        Path::new(&resolved_source).is_dir()
    };
    if directory {
        let names: Vec<String> = if let Some(remote) = source_remote {
            remote.child_names(&resolved_source)?
        } else {
            fs::read_dir(&resolved_source)
                .map_err(|e| NativeError::from_io(&e, "Unable to read source folder"))?
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        };
        // Every name is checked before anything is created, so a server
        // cannot steer a copy outside the destination folder.
        for name in &names {
            validate_entry_name(name).map_err(|e| e.with_path(&resolved_source))?;
            if target_remote.is_none() {
                local_child(destination, name).map_err(|e| e.with_path(&resolved_source))?;
            }
        }
        if let Some(remote) = target_remote {
            remote.create_folder(destination)?;
        } else {
            fs::create_dir(destination)
                .map_err(|e| NativeError::from_io(&e, "Unable to create destination folder"))?;
        }
        for name in names {
            let child_source = if source_remote.is_some() {
                remote_join(&resolved_source, &name)
            } else {
                Path::new(&resolved_source)
                    .join(&name)
                    .to_string_lossy()
                    .into_owned()
            };
            let child_destination = if target_remote.is_some() {
                remote_join(destination, &name)
            } else {
                local_child(destination, &name)?
            };
            copy_entry(
                filesystem,
                source_remote,
                &child_source,
                target_remote,
                &child_destination,
            )?;
        }
    } else {
        let reader: Box<dyn TransferRead + '_> = if let Some(remote) = source_remote {
            remote.open_read(&resolved_source)?
        } else {
            Box::new(LocalRead(fs::File::open(&resolved_source).map_err(
                |e| NativeError::from_io(&e, "Unable to open source file"),
            )?))
        };
        let writer: Box<dyn TransferWrite + '_> = if let Some(remote) = target_remote {
            remote.create_new(destination)?
        } else {
            Box::new(LocalWrite(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(destination)
                    .map_err(|e| NativeError::from_io(&e, "Unable to create destination file"))?,
            ))
        };
        if let Err(error) = copy_stream(reader, writer) {
            // The destination was created by this copy (create-new above),
            // so a partial file is removed. Best effort: the original error
            // is reported either way.
            if let Some(remote) = target_remote {
                let _ = remote.remove(destination);
            } else {
                let _ = fs::remove_file(destination);
            }
            return Err(if error.path.is_none() {
                error.with_path(destination)
            } else {
                error
            });
        }
    }
    Ok(())
}

#[cfg(test)]
// Test endpoints are single-threaded; Arc only matches the trait signature.
#[allow(clippy::arc_with_non_send_sync)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::{BTreeMap, HashMap},
        rc::Rc,
    };

    fn missing(path: &str) -> NativeError {
        NativeError::new("ESFTP", "The SFTP operation failed").with_path(path)
    }

    struct Sink(Rc<RefCell<BTreeMap<String, Option<Vec<u8>>>>>, String);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(Some(content)) = self.0.borrow_mut().get_mut(&self.1) {
                content.extend_from_slice(bytes);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // A destination named `*.reject` is refused by the "server" only after it
    // received every byte, like an FTP 451/552 final reply.
    impl TransferWrite for Sink {
        fn finish(self: Box<Self>) -> Result<(), NativeError> {
            if self.1.ends_with(".reject") {
                Err(NativeError::new(
                    "EFTP_TRANSFER",
                    "rejected after all bytes",
                ))
            } else {
                Ok(())
            }
        }
    }
    struct Source(std::io::Cursor<Vec<u8>>, String);
    impl Read for Source {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buffer)
        }
    }
    impl TransferRead for Source {
        fn finish(self: Box<Self>) -> Result<(), NativeError> {
            if self.1.contains("reject-read") {
                Err(NativeError::new(
                    "EFTP_TRANSFER",
                    "download rejected at the end",
                ))
            } else {
                Ok(())
            }
        }
    }

    pub struct Shared(pub Rc<RefCell<BTreeMap<String, Option<Vec<u8>>>>>, pub bool);

    impl RemoteEndpoint for Shared {
        fn resolve(&self, requested: &str) -> Result<String, NativeError> {
            if !requested.starts_with('/') || requested.split('/').any(|p| p == "..") {
                return Err(NativeError::new("EINVAL", "Invalid remote path"));
            }
            Ok(if requested.len() > 1 {
                requested.trim_end_matches('/').to_string()
            } else {
                requested.to_string()
            })
        }
        fn is_directory(&self, path: &str) -> Result<bool, NativeError> {
            match self.0.borrow().get(path) {
                Some(entry) => Ok(entry.is_none()),
                None => Err(missing(path)),
            }
        }
        fn child_names(&self, path: &str) -> Result<Vec<String>, NativeError> {
            let prefix = format!("{}/", path.trim_end_matches('/'));
            Ok(self
                .0
                .borrow()
                .keys()
                .filter_map(|key| key.strip_prefix(&prefix))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
                .map(str::to_string)
                .collect())
        }
        fn open_read(&self, path: &str) -> Result<Box<dyn TransferRead + '_>, NativeError> {
            match self.0.borrow().get(path) {
                Some(Some(content)) => Ok(Box::new(Source(
                    std::io::Cursor::new(content.clone()),
                    path.into(),
                ))),
                _ => Err(missing(path)),
            }
        }
        fn create_new(&self, path: &str) -> Result<Box<dyn TransferWrite + '_>, NativeError> {
            let mut entries = self.0.borrow_mut();
            if entries.contains_key(path) {
                return Err(NativeError::new("ESFTP", "The SFTP operation failed"));
            }
            entries.insert(path.into(), Some(vec![]));
            Ok(Box::new(Sink(Rc::clone(&self.0), path.into())))
        }
        fn create_folder(&self, path: &str) -> Result<(), NativeError> {
            let mut entries = self.0.borrow_mut();
            if entries.contains_key(path) {
                return Err(NativeError::new("ESFTP", "The SFTP operation failed"));
            }
            entries.insert(path.into(), None);
            Ok(())
        }
        fn rename(&self, from: &str, to: &str) -> Result<(), NativeError> {
            let mut entries = self.0.borrow_mut();
            let moved: Vec<_> = entries
                .keys()
                .filter(|key| *key == from || key.starts_with(&format!("{from}/")))
                .cloned()
                .collect();
            if moved.is_empty() {
                return Err(missing(from));
            }
            for key in moved {
                let value = entries.remove(&key).unwrap();
                entries.insert(format!("{to}{}", &key[from.len()..]), value);
            }
            Ok(())
        }
        fn remove(&self, requested: &str) -> Result<(), NativeError> {
            if self.1 {
                return Err(NativeError::new("ESFTP", "The SFTP operation failed"));
            }
            let path = self.resolve(requested)?;
            self.0
                .borrow_mut()
                .retain(|key, _| key != &path && !key.starts_with(&format!("{path}/")));
            Ok(())
        }
    }

    #[derive(Default)]
    pub struct Sessions(pub HashMap<String, Arc<dyn RemoteEndpoint>>);
    impl RemoteSessions for Sessions {
        fn endpoint(&self, provider_id: &str) -> Result<Arc<dyn RemoteEndpoint>, NativeError> {
            self.0.get(provider_id).cloned().ok_or_else(|| {
                NativeError::new("ESSH_DISCONNECTED", "The remote connection is disconnected")
            })
        }
    }

    fn store(entries: &[(&str, Option<&[u8]>)]) -> Rc<RefCell<BTreeMap<String, Option<Vec<u8>>>>> {
        Rc::new(RefCell::new(
            entries
                .iter()
                .map(|(path, content)| (path.to_string(), content.map(<[u8]>::to_vec)))
                .collect(),
        ))
    }

    fn request(value: serde_json::Value) -> OperationRequest {
        serde_json::from_value(value).unwrap()
    }

    fn local_root(label: &str) -> (std::path::PathBuf, Filesystem) {
        let root = std::env::temp_dir().join(format!(
            "vesper-remote-ops-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let filesystem = Filesystem::from_root(root.clone(), root.clone()).unwrap();
        (root, filesystem)
    }

    #[test]
    fn copies_a_remote_tree_to_local_and_back_to_another_remote() {
        let (root, filesystem) = local_root("tree");
        let a = store(&[
            ("/", None),
            ("/src", None),
            ("/src/a.txt", Some(b"alpha")),
            ("/src/nested", None),
            ("/src/nested/b.txt", Some(b"beta")),
        ]);
        let b = store(&[("/", None), ("/in", None)]);
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        sessions
            .0
            .insert("sftp:b".into(), Arc::new(Shared(Rc::clone(&b), false)));
        let local_target = root.to_string_lossy().into_owned();
        operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"sftp:a","sourcePath":"/src",
            "targetFilesystemId":"local","targetDirectory":local_target})),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("src/nested/b.txt")).unwrap(), b"beta");
        let result = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"local","sourcePath":root.join("src").to_string_lossy(),
            "targetFilesystemId":"sftp:b","targetDirectory":"/in"})),
        )
        .unwrap();
        assert_eq!(result.destination_path.as_deref(), Some("/in/src"));
        assert_eq!(
            b.borrow().get("/in/src/a.txt").cloned().flatten().unwrap(),
            b"alpha"
        );
        operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"move","filesystemId":"sftp:a","sourcePath":"/src/nested",
            "targetFilesystemId":"sftp:b","targetDirectory":"/in"})),
        )
        .unwrap();
        assert!(b.borrow().contains_key("/in/nested/b.txt"));
        assert!(!a.borrow().contains_key("/src/nested"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_connection_move_renames_and_rejects_cycles_and_same_path() {
        let (root, filesystem) = local_root("same");
        let a = store(&[
            ("/", None),
            ("/d", None),
            ("/d/x", Some(b"x")),
            ("/e", None),
        ]);
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        let run = |action: &str, source: &str, target: &str| {
            operate(
                &filesystem,
                &sessions,
                request(serde_json::json!({
                "action":action,"filesystemId":"sftp:a","sourcePath":source,
                "targetFilesystemId":"sftp:a","targetDirectory":target})),
            )
        };
        assert_eq!(run("copy", "/d", "/").unwrap_err().code, "ESAMEPATH");
        assert_eq!(run("move", "/d", "/d").unwrap_err().code, "ECYCLE");
        run("move", "/d", "/e").unwrap();
        assert!(a.borrow().contains_key("/e/d/x"));
        assert_eq!(run("link", "/e/d", "/").unwrap_err().code, "ENOTSUPPORTED");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cross_provider_move_keeps_the_copy_when_source_removal_fails() {
        let (root, filesystem) = local_root("partial");
        let a = store(&[("/", None), ("/f.txt", Some(b"data"))]);
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), true)));
        let error = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"move","filesystemId":"sftp:a","sourcePath":"/f.txt",
            "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()})),
        )
        .unwrap_err();
        assert_eq!(error.code, "EPARTIAL_MOVE");
        assert_eq!(fs::read(root.join("f.txt")).unwrap(), b"data");
        assert!(a.borrow().contains_key("/f.txt"));
        // An existing destination is never overwritten.
        let error = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"sftp:a","sourcePath":"/f.txt",
            "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()})),
        )
        .unwrap_err();
        assert_eq!(error.code, "EEXIST");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_rename_delete_and_unknown_providers() {
        let (root, filesystem) = local_root("misc");
        let a = store(&[("/", None), ("/old", Some(b""))]);
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        for action in ["create-file", "create-folder"] {
            operate(&filesystem, &sessions, request(serde_json::json!({
                "action":action,"name":action,"targetFilesystemId":"sftp:a","targetDirectory":"/"})))
            .unwrap();
        }
        assert_eq!(a.borrow().get("/create-folder"), Some(&None));
        assert_eq!(
            operate(&filesystem, &sessions, request(serde_json::json!({
                "action":"create-file","name":"../x","targetFilesystemId":"sftp:a","targetDirectory":"/"})))
            .unwrap_err()
            .code,
            "EINVALID_NAME"
        );
        let renamed = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"rename","name":"new","filesystemId":"sftp:a","sourcePath":"/old"})),
        )
        .unwrap();
        assert_eq!(renamed.destination_path.as_deref(), Some("/new"));
        operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"delete","filesystemId":"sftp:a","sourcePath":"/new"})),
        )
        .unwrap();
        assert!(!a.borrow().contains_key("/new"));
        for (source, target) in [("webdav:a", "local"), ("sftp:a", "smb:x")] {
            assert_eq!(
                operate(
                    &filesystem,
                    &sessions,
                    request(serde_json::json!({
                    "action":"copy","filesystemId":source,"sourcePath":"/create-file",
                    "targetFilesystemId":target,"targetDirectory":"/"}))
                )
                .unwrap_err()
                .code,
                "EFILESYSTEM_ID"
            );
        }
        assert_eq!(
            operate(
                &filesystem,
                &sessions,
                request(serde_json::json!({
                "action":"copy","filesystemId":"sftp:gone","sourcePath":"/x",
                "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()}))
            )
            .unwrap_err()
            .code,
            "ESSH_DISCONNECTED"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfers_succeed_only_after_both_sides_confirm_completion() {
        let (root, filesystem) = local_root("finish");
        let payload: Vec<u8> = (0..(TRANSFER_CHUNK * 3 + 17)).map(|i| i as u8).collect();
        let a = store(&[
            ("/", None),
            ("/data.bin", Some(payload.as_slice())),
            ("/reject-read.bin", Some(b"abc")),
        ]);
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        fs::write(root.join("data.reject"), &payload).unwrap();
        // Upload rejected after every byte: an error, and no partial file.
        let error = operate(&filesystem, &sessions, request(serde_json::json!({
            "action":"copy","filesystemId":"local","sourcePath":root.join("data.reject").to_string_lossy(),
            "targetFilesystemId":"sftp:a","targetDirectory":"/"})))
        .unwrap_err();
        assert_eq!(error.code, "EFTP_TRANSFER");
        assert!(!a.borrow().contains_key("/data.reject"));
        // Download refused at the end: no local file remains.
        let error = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"sftp:a","sourcePath":"/reject-read.bin",
            "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()})),
        )
        .unwrap_err();
        assert_eq!(error.code, "EFTP_TRANSFER");
        assert!(!root.join("reject-read.bin").exists());
        // A multi-chunk file arrives intact.
        operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"sftp:a","sourcePath":"/data.bin",
            "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()})),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("data.bin")).unwrap(), payload);
        // An expired deadline stops a copy between chunks and cleans up.
        crate::filesystem::jobs::set_test_deadline(Some(std::time::Instant::now()));
        let error = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","name":"again.bin","filesystemId":"sftp:a","sourcePath":"/data.bin",
            "targetFilesystemId":"sftp:a","targetDirectory":"/"})),
        )
        .unwrap_err();
        crate::filesystem::jobs::set_test_deadline(None);
        assert_eq!(error.code, "ETIMEDOUT");
        assert!(!a.borrow().contains_key("/again.bin"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entry_names_from_any_endpoint_are_single_safe_components() {
        for name in [
            "",
            ".",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "..\\x",
            "/abs",
            "nul\0",
            "bell\u{7}",
            "c1\u{85}",
        ] {
            assert_eq!(
                validate_entry_name(name).unwrap_err().code,
                "EUNSAFE_NAME",
                "{name:?}"
            );
        }
        for name in [
            "файл с пробелами.txt",
            " leading",
            "trailing ",
            "漢字",
            "a.b.c",
            "...",
            "-rf",
        ] {
            assert!(validate_entry_name(name).is_ok(), "{name:?}");
        }
        let (root, _filesystem) = local_root("child");
        let directory = root.to_string_lossy().into_owned();
        assert_eq!(
            local_child(&directory, "plain.txt").unwrap(),
            root.join("plain.txt").to_string_lossy()
        );
        #[cfg(windows)]
        for name in ["C:escape", "x:stream", "trailing.", "trailing ", "a?b"] {
            assert!(local_child(&directory, name).is_err(), "{name:?}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_hostile_child_name_stops_copy_before_creating_the_destination() {
        let (root, filesystem) = local_root("hostile");
        let a = store(&[("/", None), ("/tree", None), ("/tree/ok.txt", Some(b"ok"))]);
        // A child that is not a single component, as a hostile server could list it.
        a.borrow_mut()
            .insert("/tree/..".into(), Some(b"x".to_vec()));
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        fs::create_dir(root.join("target")).unwrap();
        let error = operate(
            &filesystem,
            &sessions,
            request(serde_json::json!({
            "action":"copy","filesystemId":"sftp:a","sourcePath":"/tree",
            "targetFilesystemId":"local","targetDirectory":root.join("target").to_string_lossy()})),
        )
        .unwrap_err();
        assert_eq!(error.code, "EUNSAFE_NAME");
        assert!(!root.join("target/tree").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_selected_item_and_copy_as_names_follow_local_name_rules() {
        let (root, filesystem) = local_root("top-level");
        let names: &[&str] = if cfg!(windows) {
            &["C:escape", "file.txt:stream", "trailing.", "a?b"]
        } else {
            &[]
        };
        let mut entries: Vec<(String, Option<&[u8]>)> =
            vec![("/".into(), None), ("/ok.txt".into(), Some(b"ok"))];
        entries.extend(
            names
                .iter()
                .map(|name| (format!("/{name}"), Some(b"x" as &[u8]))),
        );
        let a = Rc::new(RefCell::new(
            entries
                .into_iter()
                .map(|(path, content)| (path, content.map(<[u8]>::to_vec)))
                .collect::<BTreeMap<_, _>>(),
        ));
        let mut sessions = Sessions::default();
        sessions
            .0
            .insert("sftp:a".into(), Arc::new(Shared(Rc::clone(&a), false)));
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        let copy = |source: &str, name: Option<&str>| {
            let mut value = serde_json::json!({"action":"copy","filesystemId":"sftp:a","sourcePath":source,
                "targetFilesystemId":"local","targetDirectory":target.to_string_lossy()});
            if let Some(name) = name {
                value["name"] = serde_json::json!(name);
            }
            operate(&filesystem, &sessions, request(value))
        };
        // Selected items and Copy As names with a drive prefix, a stream or
        // other Windows-invalid forms are refused before anything is written.
        for name in names {
            let error = copy(&format!("/{name}"), None).unwrap_err();
            assert_eq!(error.code, "EINVALID_NAME", "{name}");
            let error = copy("/ok.txt", Some(name)).unwrap_err();
            assert_eq!(error.code, "EINVALID_NAME", "Copy As {name}");
        }
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        if let Some(parent) = root.parent() {
            assert!(!parent.join("escape").exists());
        }
        // Ordinary names, including Copy As with Unicode and spaces, work.
        copy("/ok.txt", None).unwrap();
        copy("/ok.txt", Some("копия файла.txt")).unwrap();
        assert_eq!(fs::read(target.join("копия файла.txt")).unwrap(), b"ok");
        fs::remove_dir_all(root).unwrap();
    }
}
