use crate::{
    error::NativeError,
    filesystem::{
        operations::{OperationRequest, OperationResult},
        paths, FileEntry, Filesystem,
    },
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, FileStat, HashType, OpenFlags, OpenType, Session, Sftp};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const DIRECTORY_MODE: u32 = 0o040000;
const SYMLINK_MODE: u32 = 0o120000;
const TYPE_MASK: u32 = 0o170000;
const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub private_key_path: Option<String>,
    pub initial_path: Option<String>,
    pub trusted_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_fingerprint: Option<String>,
}

#[derive(Debug)]
pub struct ConnectError {
    pub error: NativeError,
    pub host_key: Option<HostKeyInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub connection_id: String,
    pub provider_id: String,
    pub status: &'static str,
    pub root: FileEntry,
    pub initial: FileEntry,
    pub home_path: String,
}

struct RemoteConnection {
    profile: ConnectionProfile,
    secret: String,
    session: Session,
    sftp: Sftp,
    root: String,
    initial: String,
    home: String,
    connected: AtomicBool,
    app: AppHandle,
}

enum TerminalCommand {
    Write(String),
    Resize(u32, u32),
    Close,
}

pub struct SshManager {
    connections: Mutex<HashMap<String, Arc<RemoteConnection>>>,
    terminals: Mutex<HashMap<String, mpsc::Sender<TerminalCommand>>>,
}

impl SshManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
        })
    }

    pub fn connect(
        self: &Arc<Self>,
        app: AppHandle,
        profile: ConnectionProfile,
        secret: String,
    ) -> Result<ConnectResult, ConnectError> {
        validate_profile(&profile).map_err(|error| ConnectError {
            error,
            host_key: None,
        })?;
        let session = connect_session(&profile, &secret)?;
        session.set_keepalive(true, 30);
        let sftp = session
            .sftp()
            .map_err(|error| connect_native(error, "SFTP is unavailable"))?;
        let home = sftp
            .realpath(Path::new("."))
            .map_err(|error| connect_native(error, "Unable to resolve the remote home directory"))?
            .to_string_lossy()
            .replace('\\', "/");
        let initial = initial_remote_path(&profile).map_err(|error| ConnectError {
            error,
            host_key: None,
        })?;
        let stat = sftp
            .stat(Path::new(&initial))
            .map_err(|error| connect_native(error, "Initial remote directory was not found"))?;
        if !is_directory(&stat) {
            return Err(ConnectError {
                error: NativeError::new("ENOTDIR", "Initial remote path is not a folder"),
                host_key: None,
            });
        }
        let connection = Arc::new(RemoteConnection {
            profile: profile.clone(),
            secret,
            session,
            sftp,
            root: "/".to_string(),
            initial,
            home: home.clone(),
            connected: AtomicBool::new(true),
            app: app.clone(),
        });
        let root_entry = connection.root_entry();
        let initial_entry = connection.initial_entry();
        self.connections
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .insert(profile.id.clone(), Arc::clone(&connection));
        let keepalive = connection.session.clone();
        let weak_connection = Arc::downgrade(&connection);
        let weak_manager = Arc::downgrade(self);
        let connection_id = profile.id.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(30));
            if keepalive.keepalive_send().is_ok() {
                continue;
            }
            let Some(connection) = weak_connection.upgrade() else {
                break;
            };
            connection.connected.store(false, Ordering::Release);
            let is_current = weak_manager.upgrade().is_some_and(|manager| {
                manager
                    .connections
                    .lock()
                    .unwrap_or_else(|value| value.into_inner())
                    .get(&connection_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &connection))
            });
            if is_current {
                let _ = connection.app.emit(
                    "ssh:status",
                    serde_json::json!({"connectionId":connection_id,"status":"disconnected"}),
                );
            }
            break;
        });
        let _ = app.emit(
            "ssh:status",
            serde_json::json!({"connectionId":profile.id,"status":"connected"}),
        );
        Ok(ConnectResult {
            connection_id: profile.id.clone(),
            provider_id: format!("sftp:{}", profile.id),
            status: "connected",
            root: root_entry,
            initial: initial_entry,
            home_path: home,
        })
    }

    pub fn disconnect(&self, id: &str) {
        if let Some(connection) = self
            .connections
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .remove(id)
        {
            connection.connected.store(false, Ordering::Release);
            let _ = connection
                .session
                .disconnect(None, "Vesperwind disconnected", None);
        }
    }
    pub fn status(&self, id: &str) -> &'static str {
        if self
            .connections
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .get(id)
            .is_some_and(|connection| connection.connected.load(Ordering::Acquire))
        {
            "connected"
        } else {
            "disconnected"
        }
    }
    fn get(&self, provider_id: &str) -> Result<Arc<RemoteConnection>, NativeError> {
        let id = provider_id.strip_prefix("sftp:").ok_or_else(|| {
            NativeError::new("EFILESYSTEM_ID", "This filesystem is not available")
        })?;
        let connection = self
            .connections
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new("ESSH_DISCONNECTED", "The remote connection is disconnected")
            })?;
        if !connection.connected.load(Ordering::Acquire) {
            return Err(NativeError::new(
                "ESSH_DISCONNECTED",
                "The remote connection is disconnected",
            ));
        }
        Ok(connection)
    }
    fn reconnect(
        self: &Arc<Self>,
        provider_id: &str,
    ) -> Result<Arc<RemoteConnection>, NativeError> {
        let id = provider_id.strip_prefix("sftp:").ok_or_else(|| {
            NativeError::new("EFILESYSTEM_ID", "This filesystem is not available")
        })?;
        let stale = self
            .connections
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new("ESSH_DISCONNECTED", "The remote connection is disconnected")
            })?;
        self.connect(
            stale.app.clone(),
            stale.profile.clone(),
            stale.secret.clone(),
        )
        .map_err(|error| error.error)?;
        self.get(provider_id)
    }
    fn ensure(self: &Arc<Self>, provider_id: &str) -> Result<Arc<RemoteConnection>, NativeError> {
        self.get(provider_id)
            .or_else(|_| self.reconnect(provider_id))
    }
    pub fn root(
        self: &Arc<Self>,
        provider_id: &str,
    ) -> Result<(FileEntry, FileEntry, String), NativeError> {
        let c = self.ensure(provider_id)?;
        Ok((c.root_entry(), c.initial_entry(), c.home.clone()))
    }
    pub fn list(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<Vec<FileEntry>, NativeError> {
        let connection = self.ensure(provider_id)?;
        match connection.list(requested) {
            Ok(entries) => Ok(entries),
            Err(error) if matches!(error.code.as_str(), "ESFTP" | "ESSH" | "ESSH_DISCONNECTED") => {
                connection.connected.store(false, Ordering::Release);
                let _ = connection.app.emit(
                    "ssh:status",
                    serde_json::json!({"connectionId":connection.profile.id,"status":"disconnected"}),
                );
                self.reconnect(provider_id)?.list(requested)
            }
            Err(error) => Err(error),
        }
    }
    pub fn read_text(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<(String, Option<String>), NativeError> {
        let connection = self.ensure(provider_id)?;
        match connection.read_text(requested) {
            Ok(result) => Ok(result),
            Err(error) if matches!(error.code.as_str(), "ESFTP" | "ESSH" | "ESSH_DISCONNECTED") => {
                connection.connected.store(false, Ordering::Release);
                let _ = connection.app.emit(
                    "ssh:status",
                    serde_json::json!({"connectionId":connection.profile.id,"status":"disconnected"}),
                );
                self.reconnect(provider_id)?.read_text(requested)
            }
            Err(error) => Err(error),
        }
    }
    pub fn write_text(
        &self,
        provider_id: &str,
        requested: &str,
        content: &str,
    ) -> Result<Option<String>, NativeError> {
        self.get(provider_id)?.write_text(requested, content)
    }

    pub fn content_metadata(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<(String, u64), NativeError> {
        let connection = self.ensure(provider_id)?;
        let path = connection.resolve(requested)?;
        let stat = connection.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        if is_directory(&stat) {
            return Err(NativeError::new(
                "ENOTFILE",
                "The requested path is not a file",
            ));
        }
        Ok((path, stat.size.unwrap_or(0)))
    }

    pub fn open_content_stream(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<ssh2::File, NativeError> {
        let connection = self.ensure(provider_id)?;
        let path = connection.resolve(requested)?;
        connection.sftp.open(Path::new(&path)).map_err(sftp_error)
    }

    pub fn operate(
        &self,
        filesystem: &Filesystem,
        request: OperationRequest,
    ) -> Result<OperationResult, NativeError> {
        let source_remote = request
            .filesystem_id
            .as_deref()
            .and_then(|v| v.strip_prefix("sftp:"));
        let target_remote = request
            .target_filesystem_id
            .as_deref()
            .and_then(|v| v.strip_prefix("sftp:"));
        if request.action == "create-file" || request.action == "create-folder" {
            validate_name(request.name.as_deref())?;
            let target = self.get(request.target_filesystem_id.as_deref().unwrap_or(""))?;
            let directory = request
                .target_directory
                .as_deref()
                .ok_or_else(|| NativeError::new("EINVAL", "A destination folder is required"))?;
            let destination = target.resolve(&remote_join(
                directory,
                request.name.as_deref().unwrap_or(""),
            ))?;
            if request.action == "create-folder" {
                target
                    .sftp
                    .mkdir(Path::new(&destination), 0o755)
                    .map_err(sftp_error)?;
            } else {
                target
                    .sftp
                    .open_mode(
                        Path::new(&destination),
                        OpenFlags::CREATE | OpenFlags::EXCLUSIVE | OpenFlags::WRITE,
                        0o644,
                        OpenType::File,
                    )
                    .map_err(sftp_error)?;
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
        let source_connection = source_remote
            .map(|_| self.get(request.filesystem_id.as_deref().unwrap()))
            .transpose()?;
        if request.action == "delete" {
            source_connection.as_ref().unwrap().remove(source_path)?;
            return Ok(operation_result(
                "delete",
                Some(source_path.to_string()),
                None,
                None,
            ));
        }
        if request.action == "rename" {
            validate_name(request.name.as_deref())?;
            let source = source_connection.as_ref().unwrap().resolve(source_path)?;
            let destination = source_connection.as_ref().unwrap().resolve(&remote_join(
                &remote_parent(&source),
                request.name.as_deref().unwrap_or(""),
            ))?;
            source_connection
                .as_ref()
                .unwrap()
                .sftp
                .rename(Path::new(&source), Path::new(&destination), None)
                .map_err(sftp_error)?;
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
        let target_connection = target_remote
            .map(|_| self.get(request.target_filesystem_id.as_deref().unwrap()))
            .transpose()?;
        let source_name = if source_remote.is_some() {
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
            paths::resolve_inside_root(filesystem, &target.join(source_name).to_string_lossy())?
                .to_string_lossy()
                .into_owned()
        };
        if source_remote.is_some() && source_remote == target_remote {
            let source = source_connection.as_ref().unwrap().resolve(source_path)?;
            if source == destination {
                return Err(NativeError::new(
                    "ESAMEPATH",
                    "The item is already in this folder",
                ));
            }
            let stat = source_connection
                .as_ref()
                .unwrap()
                .sftp
                .lstat(Path::new(&source))
                .map_err(sftp_error)?;
            if is_directory(&stat)
                && destination.starts_with(&(source.trim_end_matches('/').to_string() + "/"))
            {
                return Err(NativeError::new(
                    "ECYCLE",
                    "A folder cannot be copied or moved into itself",
                ));
            }
        }
        if request.action == "move" && source_remote.is_some() && source_remote == target_remote {
            let source = source_connection.as_ref().unwrap().resolve(source_path)?;
            source_connection
                .as_ref()
                .unwrap()
                .sftp
                .rename(Path::new(&source), Path::new(&destination), None)
                .map_err(sftp_error)?;
        } else {
            copy_entry(
                filesystem,
                source_connection.as_deref(),
                source_path,
                target_connection.as_deref(),
                &destination,
            )?;
            if request.action == "move" {
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
                    return Err(NativeError::new("EPARTIAL_MOVE", format!("The copy completed at {destination}, but the source could not be removed")));
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

    pub fn create_terminal(
        self: &Arc<Self>,
        app: AppHandle,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(String, String), NativeError> {
        let connection = self.ensure(&format!("sftp:{connection_id}"))?;
        let session =
            connect_session(&connection.profile, &connection.secret).map_err(|e| e.error)?;
        let mut channel = session.channel_session().map_err(ssh_error)?;
        channel
            .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
            .map_err(ssh_error)?;
        channel.shell().map_err(ssh_error)?;
        session.set_keepalive(true, 30);
        session.set_blocking(false);
        let (sender, receiver) = mpsc::channel();
        let id = Uuid::new_v4().to_string();
        self.terminals
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .insert(id.clone(), sender);
        let manager = Arc::clone(self);
        let output_id = id.clone();
        thread::spawn(move || {
            run_terminal(&mut channel, &session, receiver, &app, &output_id, &manager)
        });
        Ok((
            id,
            format!(
                "{}@{}",
                connection.profile.username, connection.profile.host
            ),
        ))
    }
    pub fn terminal_write(&self, id: &str, data: String) {
        if let Some(tx) = self
            .terminals
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .get(id)
        {
            let _ = tx.send(TerminalCommand::Write(data));
        }
    }
    pub fn terminal_resize(&self, id: &str, cols: u32, rows: u32) {
        if let Some(tx) = self
            .terminals
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .get(id)
        {
            let _ = tx.send(TerminalCommand::Resize(cols, rows));
        }
    }
    pub fn terminal_close(&self, id: &str) {
        if let Some(tx) = self
            .terminals
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .remove(id)
        {
            let _ = tx.send(TerminalCommand::Close);
        }
    }
    pub fn shutdown(&self) {
        for (_, tx) in self
            .terminals
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .drain()
        {
            let _ = tx.send(TerminalCommand::Close);
        }
        for connection in self
            .connections
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .values()
        {
            let _ = connection
                .session
                .disconnect(None, "Vesperwind shutdown", None);
        }
    }
}

impl RemoteConnection {
    fn resolve(&self, requested: &str) -> Result<String, NativeError> {
        let value = normalize_remote(requested)?;
        if value != self.root
            && !value.starts_with(&(self.root.trim_end_matches('/').to_string() + "/"))
        {
            return Err(NativeError::new(
                "EOUTSIDE_ROOT",
                "Path is outside this remote connection root",
            ));
        }
        Ok(value)
    }
    fn root_entry(&self) -> FileEntry {
        directory_entry(&self.root)
    }
    fn initial_entry(&self) -> FileEntry {
        directory_entry(&self.initial)
    }
    fn list(&self, requested: &str) -> Result<Vec<FileEntry>, NativeError> {
        let directory = self.resolve(requested)?;
        let mut result = Vec::new();
        for (path, stat) in self
            .sftp
            .readdir(Path::new(&directory))
            .map_err(sftp_error)?
        {
            let name = path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_string();
            if name == "." || name == ".." {
                continue;
            }
            let is_directory = is_directory(&stat);
            let mode = stat.perm.unwrap_or(0);
            result.push(FileEntry {
                name: name.clone(),
                path: remote_join(&directory, &name),
                entry_type: if is_directory { "directory" } else { "file" },
                is_directory,
                is_symbolic_link: mode & TYPE_MASK == SYMLINK_MODE,
                size: (!is_directory).then_some(stat.size.unwrap_or(0)),
                modified_at: stat.mtime.map(|v| {
                    chrono::DateTime::from_timestamp(v as i64, 0)
                        .unwrap_or_default()
                        .to_rfc3339()
                }),
                metadata_error: None,
            });
        }
        result.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(result)
    }
    fn read_text(&self, requested: &str) -> Result<(String, Option<String>), NativeError> {
        let path = self.resolve(requested)?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        if stat.size.unwrap_or(0) > MAX_TEXT_BYTES {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 10 MB cannot be opened in the editor",
            ));
        }
        let mut file = self.sftp.open(Path::new(&path)).map_err(sftp_error)?;
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| NativeError::from_io(&e, "Unable to read remote text"))?;
        Ok((
            content,
            stat.mtime.map(|v| {
                chrono::DateTime::from_timestamp(v as i64, 0)
                    .unwrap_or_default()
                    .to_rfc3339()
            }),
        ))
    }
    fn write_text(&self, requested: &str, content: &str) -> Result<Option<String>, NativeError> {
        if content.len() as u64 > MAX_TEXT_BYTES {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 10 MB cannot be opened in the editor",
            ));
        }
        let path = self.resolve(requested)?;
        let mut file = self.sftp.create(Path::new(&path)).map_err(sftp_error)?;
        file.write_all(content.as_bytes())
            .map_err(|e| NativeError::from_io(&e, "Unable to save remote text"))?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        Ok(stat.mtime.map(|v| {
            chrono::DateTime::from_timestamp(v as i64, 0)
                .unwrap_or_default()
                .to_rfc3339()
        }))
    }
    fn remove(&self, requested: &str) -> Result<(), NativeError> {
        let path = self.resolve(requested)?;
        let stat = self.sftp.lstat(Path::new(&path)).map_err(sftp_error)?;
        if is_directory(&stat) {
            for (child, _) in self.sftp.readdir(Path::new(&path)).map_err(sftp_error)? {
                let name = child.file_name().and_then(|v| v.to_str()).unwrap_or("");
                if name != "." && name != ".." {
                    self.remove(&remote_join(&path, name))?;
                }
            }
            self.sftp.rmdir(Path::new(&path)).map_err(sftp_error)
        } else {
            self.sftp.unlink(Path::new(&path)).map_err(sftp_error)
        }
    }
}

fn directory_entry(path: &str) -> FileEntry {
    FileEntry {
        name: remote_name(path).to_string(),
        path: path.to_string(),
        entry_type: "directory",
        is_directory: true,
        is_symbolic_link: false,
        size: None,
        modified_at: None,
        metadata_error: None,
    }
}

fn connect_session(profile: &ConnectionProfile, secret: &str) -> Result<Session, ConnectError> {
    let tcp =
        TcpStream::connect((profile.host.as_str(), profile.port)).map_err(|e| ConnectError {
            error: NativeError::from_io(&e, "Unable to connect to the SSH server"),
            host_key: None,
        })?;
    tcp.set_read_timeout(Some(Duration::from_secs(20))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(20))).ok();
    let mut session = Session::new().map_err(|e| connect_native(e, "Unable to initialize SSH"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| connect_native(e, "SSH handshake failed"))?;
    let observed = format!(
        "SHA256:{}",
        STANDARD_NO_PAD.encode(session.host_key_hash(HashType::Sha256).ok_or_else(|| {
            ConnectError {
                error: NativeError::new("EHOSTKEY", "The server did not provide a host key"),
                host_key: None,
            }
        })?)
    );
    let info = HostKeyInfo {
        host: format!("{}:{}", profile.host, profile.port),
        fingerprint: observed.clone(),
        previous_fingerprint: profile
            .trusted_fingerprint
            .clone()
            .filter(|v| !v.is_empty()),
    };
    match profile
        .trusted_fingerprint
        .as_deref()
        .filter(|v| !v.is_empty())
    {
        None => {
            return Err(ConnectError {
                error: NativeError::new(
                    "EHOSTKEY_UNKNOWN",
                    "Confirm this SSH host key before connecting",
                ),
                host_key: Some(info),
            })
        }
        Some(expected) if expected != observed => {
            return Err(ConnectError {
                error: NativeError::new(
                    "EHOSTKEY_CHANGED",
                    "REMOTE HOST IDENTIFICATION HAS CHANGED",
                ),
                host_key: Some(info),
            })
        }
        _ => {}
    }
    let auth = if profile.auth_type == "password" {
        session.userauth_password(&profile.username, secret)
    } else {
        session.userauth_pubkey_file(
            &profile.username,
            None,
            Path::new(profile.private_key_path.as_deref().unwrap_or("")),
            (!secret.is_empty()).then_some(secret),
        )
    };
    auth.map_err(|e| ConnectError {
        error: NativeError::new("EAUTHENTICATION", "SSH authentication failed")
            .with_native_error(e.to_string()),
        host_key: None,
    })?;
    Ok(session)
}

fn validate_profile(p: &ConnectionProfile) -> Result<(), NativeError> {
    if p.id.is_empty()
        || !p
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        || p.host.trim().is_empty()
        || p.username.trim().is_empty()
        || p.port == 0
        || !["password", "privateKey"].contains(&p.auth_type.as_str())
    {
        return Err(NativeError::new("EINVAL", "Invalid SSH connection profile"));
    }
    if p.initial_path
        .as_deref()
        .is_some_and(|v| !v.is_empty() && (!v.starts_with('/') || v.contains('\\')))
    {
        return Err(NativeError::new(
            "EINVAL",
            "Remote paths must be absolute POSIX paths",
        ));
    }
    Ok(())
}
fn validate_name(value: Option<&str>) -> Result<(), NativeError> {
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
fn normalize_remote(value: &str) -> Result<String, NativeError> {
    if !value.starts_with('/') || value.contains('\\') || value.contains('\0') {
        return Err(NativeError::new("EINVAL", "Invalid remote path"));
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}
fn initial_remote_path(profile: &ConnectionProfile) -> Result<String, NativeError> {
    normalize_remote(
        profile
            .initial_path
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("/"),
    )
}
fn remote_join(a: &str, b: &str) -> String {
    format!("{}/{}", a.trim_end_matches('/'), b.trim_matches('/'))
}
fn remote_parent(value: &str) -> String {
    value
        .rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or("/")
        .to_string()
}
fn remote_name(value: &str) -> &str {
    value
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|v| !v.is_empty())
        .unwrap_or("/")
}
fn is_directory(stat: &FileStat) -> bool {
    stat.perm.unwrap_or(0) & TYPE_MASK == DIRECTORY_MODE
}
fn sftp_error(error: ssh2::Error) -> NativeError {
    NativeError::new("ESFTP", "The SFTP operation failed").with_native_error(error.to_string())
}
fn ssh_error(error: ssh2::Error) -> NativeError {
    NativeError::new("ESSH", "The SSH operation failed").with_native_error(error.to_string())
}
fn connect_native(error: ssh2::Error, message: &str) -> ConnectError {
    ConnectError {
        error: NativeError::new("ESSH", message).with_native_error(error.to_string()),
        host_key: None,
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

fn copy_entry(
    filesystem: &Filesystem,
    source_remote: Option<&RemoteConnection>,
    source: &str,
    target_remote: Option<&RemoteConnection>,
    destination: &str,
) -> Result<(), NativeError> {
    let resolved_source = if let Some(remote) = source_remote {
        remote.resolve(source)?
    } else {
        let local = paths::resolve_inside_root(filesystem, source)?;
        paths::verify_existing_inside_root(filesystem, &local)?
            .to_string_lossy()
            .into_owned()
    };
    let directory = if let Some(remote) = source_remote {
        is_directory(
            &remote
                .sftp
                .lstat(Path::new(&resolved_source))
                .map_err(sftp_error)?,
        )
    } else {
        Path::new(&resolved_source).is_dir()
    };
    if directory {
        if let Some(remote) = target_remote {
            remote
                .sftp
                .mkdir(Path::new(destination), 0o755)
                .map_err(sftp_error)?;
        } else {
            fs::create_dir(destination)
                .map_err(|e| NativeError::from_io(&e, "Unable to create destination folder"))?;
        }
        let names: Vec<String> = if let Some(remote) = source_remote {
            remote
                .sftp
                .readdir(Path::new(&resolved_source))
                .map_err(sftp_error)?
                .into_iter()
                .filter_map(|(p, _)| p.file_name().and_then(|v| v.to_str()).map(str::to_string))
                .filter(|v| v != "." && v != "..")
                .collect()
        } else {
            fs::read_dir(&resolved_source)
                .map_err(|e| NativeError::from_io(&e, "Unable to read source folder"))?
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        };
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
                Path::new(destination)
                    .join(&name)
                    .to_string_lossy()
                    .into_owned()
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
        let mut reader: Box<dyn Read> = if let Some(remote) = source_remote {
            Box::new(
                remote
                    .sftp
                    .open(Path::new(&resolved_source))
                    .map_err(sftp_error)?,
            )
        } else {
            Box::new(
                fs::File::open(&resolved_source)
                    .map_err(|e| NativeError::from_io(&e, "Unable to open source file"))?,
            )
        };
        let mut writer: Box<dyn Write> = if let Some(remote) = target_remote {
            Box::new(
                remote
                    .sftp
                    .open_mode(
                        Path::new(destination),
                        OpenFlags::CREATE | OpenFlags::EXCLUSIVE | OpenFlags::WRITE,
                        0o644,
                        OpenType::File,
                    )
                    .map_err(sftp_error)?,
            )
        } else {
            Box::new(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(destination)
                    .map_err(|e| NativeError::from_io(&e, "Unable to create destination file"))?,
            )
        };
        std::io::copy(&mut reader, &mut writer)
            .map_err(|e| NativeError::from_io(&e, "The file transfer failed"))?;
    }
    Ok(())
}

fn run_terminal(
    channel: &mut Channel,
    session: &Session,
    receiver: mpsc::Receiver<TerminalCommand>,
    app: &AppHandle,
    id: &str,
    manager: &SshManager,
) {
    let mut buffer = [0u8; 16384];
    let mut closed = false;
    let mut disconnected = false;
    let mut last_keepalive = Instant::now();
    while !closed {
        while let Ok(command) = receiver.try_recv() {
            match command {
                TerminalCommand::Write(data) => {
                    let _ = channel.write_all(data.as_bytes());
                }
                TerminalCommand::Resize(c, r) => {
                    let _ = channel.request_pty_size(c, r, None, None);
                }
                TerminalCommand::Close => {
                    let _ = channel.close();
                    closed = true;
                }
            }
        }
        match channel.read(&mut buffer) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => {
                let _ = app.emit(
                    "terminal:output",
                    serde_json::json!({"id":id,"data":String::from_utf8_lossy(&buffer[..n])}),
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => {
                disconnected = true;
                break;
            }
        }
        if last_keepalive.elapsed() >= Duration::from_secs(30) {
            if session.keepalive_send().is_err() {
                disconnected = true;
                break;
            }
            last_keepalive = Instant::now();
        }
        thread::sleep(Duration::from_millis(10));
    }
    manager
        .terminals
        .lock()
        .unwrap_or_else(|v| v.into_inner())
        .remove(id);
    disconnected |= !closed && !session.authenticated();
    let _ = app.emit(
        "terminal:exit",
        serde_json::json!({
            "id":id,
            "exitCode":if disconnected { Value::Null } else { Value::from(channel.exit_status().unwrap_or(0)) },
            "signal":if disconnected { Value::from("disconnected") } else { Value::Null },
            "disconnected":disconnected,
        }),
    );
}
use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::{initial_remote_path, normalize_remote, validate_profile, ConnectionProfile};

    #[test]
    fn accepts_custom_ssh_port_and_posix_remote_paths() {
        let profile = ConnectionProfile {
            id: "demo".into(),
            name: "Demo".into(),
            host: "example.com".into(),
            port: 2222,
            username: "demo".into(),
            auth_type: "privateKey".into(),
            private_key_path: Some("/keys/id_ed25519".into()),
            initial_path: Some("/home/demo".into()),
            trusted_fingerprint: None,
        };
        assert!(validate_profile(&profile).is_ok());
        assert_eq!(
            normalize_remote("/home/demo/../shared").unwrap(),
            "/home/shared"
        );
        assert!(normalize_remote(r"C:\\Users\\remote").is_err());
        assert_eq!(initial_remote_path(&profile).unwrap(), "/home/demo");

        let mut root_profile = profile;
        root_profile.initial_path = Some(String::new());
        assert_eq!(initial_remote_path(&root_profile).unwrap(), "/");
    }
}
