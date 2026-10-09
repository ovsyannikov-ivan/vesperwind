pub use crate::connections::ConnectionProfile;
use crate::{
    credential_store::CredentialStore,
    ssh_auth::{AuthContext, AuthRequired, AuthSecrets},
    ssh_config::{self, ResolvedProfile},
};
use crate::{
    error::NativeError,
    filesystem::{
        operations::OperationRequest,
        remote_ops::{remote_join, remote_name, RemoteEndpoint, RemoteSessions},
        FileEntry,
    },
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, FileStat, HashType, OpenFlags, OpenType, Session, Sftp};
use std::{
    collections::HashMap,
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
    pub auth: Option<AuthRequired>,
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
    pub credential_warning: Option<NativeError>,
}

struct RemoteConnection {
    profile: ConnectionProfile,
    auth: AuthContext,
    resolved: ResolvedProfile,
    session: Session,
    sftp: Sftp,
    root: String,
    initial: String,
    home: String,
    connected: AtomicBool,
    app: Option<AppHandle>,
}

enum TerminalCommand {
    Write(String),
    Resize(u32, u32),
    Close,
}

pub struct SshManager {
    pub credentials: Arc<CredentialStore>,
    pub profile_updates: Mutex<()>,
    settings: Option<Arc<crate::settings::SettingsStore>>,
    connections: Mutex<HashMap<String, Arc<RemoteConnection>>>,
    terminals: Mutex<HashMap<String, mpsc::Sender<TerminalCommand>>>,
}

// Sent only over the helper's private stdin pipe; never logged or persisted.
#[derive(Serialize, Deserialize)]
pub(crate) struct OperationConnection {
    resolved: ResolvedProfile,
    secrets: AuthSecrets,
    root: String,
    initial: String,
    home: String,
}

impl SshManager {
    pub fn new() -> Arc<Self> {
        Self::build(None)
    }
    pub fn with_settings(settings: Arc<crate::settings::SettingsStore>) -> Arc<Self> {
        Self::build(Some(settings))
    }
    fn build(settings: Option<Arc<crate::settings::SettingsStore>>) -> Arc<Self> {
        Arc::new(Self {
            credentials: CredentialStore::native(),
            profile_updates: Mutex::new(()),
            settings,
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
        let secrets = AuthSecrets::legacy(&profile.auth_type, secret);
        self.connect_with_auth(app, profile, secrets)
    }

    pub fn connect_with_auth(
        self: &Arc<Self>,
        app: AppHandle,
        profile: ConnectionProfile,
        secrets: AuthSecrets,
    ) -> Result<ConnectResult, ConnectError> {
        let _profile_guard = self
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        validate_profile(&profile).map_err(|error| ConnectError {
            error,
            host_key: None,
            auth: None,
        })?;
        if (profile.save_password || profile.save_key_passphrase) && self.settings.is_some() {
            let stored = self
                .settings
                .as_ref()
                .unwrap()
                .load()
                .map_err(|error| ConnectError {
                    error,
                    host_key: None,
                    auth: None,
                })?;
            let bound = stored["connections"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["id"] == profile.id))
                .and_then(|value| serde_json::from_value::<ConnectionProfile>(value.clone()).ok())
                .is_some_and(|p| {
                    p.host == profile.host
                        && p.port == profile.port
                        && p.username == profile.username
                        && p.protocol == profile.protocol
                        && p.ssh_config_host == profile.ssh_config_host
                        && p.auth_type == profile.auth_type
                        && p.private_key_path == profile.private_key_path
                        && p.save_password == profile.save_password
                        && p.save_key_passphrase == profile.save_key_passphrase
                });
            if !bound {
                return Err(ConnectError {
                    error: NativeError::new(
                        "EINVAL",
                        "Save this connection profile before using stored credentials",
                    ),
                    host_key: None,
                    auth: None,
                });
            }
        }
        let resolved = ssh_config::resolve_profile(&profile).map_err(|error| ConnectError {
            error,
            host_key: None,
            auth: None,
        })?;
        let mut auth = AuthContext::new(self.credentials.clone(), secrets);
        let session = connect_session(&resolved, &auth)?;
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
            auth: None,
        })?;
        let stat = sftp
            .stat(Path::new(&initial))
            .map_err(|error| connect_native(error, "Initial remote directory was not found"))?;
        if !is_directory(&stat) {
            return Err(ConnectError {
                error: NativeError::new("ENOTDIR", "Initial remote path is not a folder"),
                host_key: None,
                auth: None,
            });
        }
        let credential_warning = auth.persist_after_connect(&profile);
        let connection = Arc::new(RemoteConnection {
            profile: profile.clone(),
            auth,
            resolved,
            session,
            sftp,
            root: "/".to_string(),
            initial,
            home: home.clone(),
            connected: AtomicBool::new(true),
            app: Some(app.clone()),
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
                let _ = connection.emit(
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
            credential_warning,
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
        self.connect_with_auth(
            stale.app.clone().ok_or_else(|| {
                NativeError::new("ESSH_DISCONNECTED", "Helper connection cannot reconnect")
            })?,
            stale.profile.clone(),
            (*stale.auth.transient).clone(),
        )
        .map_err(|error| error.error)?;
        self.get(provider_id)
    }
    #[cfg(debug_assertions)]
    pub fn regression_reconnect(self: &Arc<Self>, provider_id: &str) -> Result<(), NativeError> {
        self.reconnect(provider_id).map(|_| ())
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
                let _ = connection.emit(
                    "ssh:status",
                    serde_json::json!({"connectionId":connection.profile.id,"status":"disconnected"}),
                );
                self.reconnect(provider_id)?.list(requested)
            }
            Err(error) => Err(error),
        }
    }
    pub fn resolve_path(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<String, NativeError> {
        self.ensure(provider_id)?.resolve(requested)
    }
    pub fn read_text(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
        max_bytes: Option<u64>,
        strict_text: bool,
    ) -> Result<(String, Option<String>), NativeError> {
        let connection = self.ensure(provider_id)?;
        match connection.read_text(requested, max_bytes, strict_text) {
            Ok(result) => Ok(result),
            Err(error) if matches!(error.code.as_str(), "ESFTP" | "ESSH" | "ESSH_DISCONNECTED") => {
                connection.connected.store(false, Ordering::Release);
                let _ = connection.emit(
                    "ssh:status",
                    serde_json::json!({"connectionId":connection.profile.id,"status":"disconnected"}),
                );
                self.reconnect(provider_id)?
                    .read_text(requested, max_bytes, strict_text)
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

    pub fn read_binary(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<(Vec<u8>, Option<String>), NativeError> {
        let connection = self.ensure(provider_id)?;
        connection.read_binary(requested)
    }

    pub fn write_binary(
        &self,
        provider_id: &str,
        requested: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, NativeError> {
        self.get(provider_id)?.write_binary(requested, bytes)
    }

    pub fn properties(
        self: &Arc<Self>,
        provider: &str,
        requested: &str,
    ) -> Result<crate::filesystem::properties::Properties, NativeError> {
        let connection = self.ensure(provider)?;
        let path = connection.resolve(requested)?;
        let stat = connection.sftp.lstat(Path::new(&path)).map_err(|error| {
            let error = properties_sftp_error(error);
            if error.code == "ESSH_DISCONNECTED" {
                connection.connected.store(false, Ordering::Release);
            }
            error
        })?;
        let target = if stat.perm.is_some_and(|m| m & TYPE_MASK == SYMLINK_MODE) {
            connection
                .sftp
                .readlink(Path::new(&path))
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        };
        Ok(crate::filesystem::properties::from_sftp(
            &path, &stat, target,
        ))
    }
    pub fn update_properties(
        self: &Arc<Self>,
        provider: &str,
        requested: &str,
        update: &crate::filesystem::properties::PermissionUpdate,
    ) -> Result<crate::filesystem::properties::Properties, NativeError> {
        let connection = self.ensure(provider)?;
        let path = connection.resolve(requested)?;
        let stat = connection.sftp.lstat(Path::new(&path)).map_err(|error| {
            let error = properties_sftp_error(error);
            if error.code == "ESSH_DISCONNECTED" {
                connection.connected.store(false, Ordering::Release);
            }
            error
        })?;
        let attributes = crate::filesystem::properties::sftp_update(&stat, update)?;
        connection
            .sftp
            .setstat(Path::new(&path), attributes)
            .map_err(|e| {
                let error = properties_sftp_error(e);
                if error.code == "ESSH_DISCONNECTED" {
                    connection.connected.store(false, Ordering::Release);
                }
                error.with_path(&path)
            })?;
        self.properties(provider, requested)
    }
    pub fn size_children(
        self: &Arc<Self>,
        provider: &str,
        requested: &str,
    ) -> Result<Vec<(String, FileStat)>, NativeError> {
        let connection = self.ensure(provider)?;
        let path = connection.resolve(requested)?;
        let stat = connection.sftp.lstat(Path::new(&path)).map_err(|error| {
            let error = properties_sftp_error(error);
            if error.code == "ESSH_DISCONNECTED" {
                connection.connected.store(false, Ordering::Release);
            }
            error
        })?;
        if !is_directory(&stat) {
            return Err(NativeError::new(
                "ENOTDIR",
                "This entry is no longer a directory",
            ));
        }
        connection
            .sftp
            .readdir(Path::new(&path))
            .map_err(sftp_error)
            .map(|entries| {
                entries
                    .into_iter()
                    .filter_map(|(child, stat)| {
                        let name = child.file_name()?.to_str()?;
                        if name == "." || name == ".." {
                            return None;
                        }
                        Some((remote_join(&path, name), stat))
                    })
                    .collect()
            })
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

    /// Metadata for native transfers. `lstat` keeps symlinks visible so callers
    /// never follow a directory link into a cycle; a symlink to a regular file
    /// reports the target's type and size.
    pub fn remote_stat(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<crate::shell_integration::transfer::RemoteStat, NativeError> {
        let connection = self.ensure(provider_id)?;
        let path = connection.resolve(requested)?;
        let lstat = connection
            .sftp
            .lstat(Path::new(&path))
            .map_err(sftp_error)?;
        let link = lstat.perm.unwrap_or(0) & TYPE_MASK == SYMLINK_MODE;
        let stat = if link {
            connection.sftp.stat(Path::new(&path)).unwrap_or(lstat)
        } else {
            lstat
        };
        Ok(remote_stat(
            remote_name(&path).to_string(),
            path,
            &stat,
            link,
        ))
    }

    pub fn remote_children(
        self: &Arc<Self>,
        provider_id: &str,
        requested: &str,
    ) -> Result<Vec<crate::shell_integration::transfer::RemoteStat>, NativeError> {
        let connection = self.ensure(provider_id)?;
        let directory = connection.resolve(requested)?;
        let mut result = vec![];
        for (child, stat) in connection
            .sftp
            .readdir(Path::new(&directory))
            .map_err(sftp_error)?
        {
            let Some(name) = child.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            let path = remote_join(&directory, name);
            let link = stat.perm.unwrap_or(0) & TYPE_MASK == SYMLINK_MODE;
            let stat = if link {
                connection.sftp.stat(Path::new(&path)).unwrap_or(stat)
            } else {
                stat
            };
            result.push(remote_stat(name.to_string(), path, &stat, link));
        }
        Ok(result)
    }

    pub(crate) fn operation_connections(
        &self,
        request: &OperationRequest,
    ) -> Result<Vec<OperationConnection>, NativeError> {
        let _guard = self
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut ids = vec![];
        let mut result = vec![];
        for provider in [&request.filesystem_id, &request.target_filesystem_id]
            .into_iter()
            .flatten()
        {
            if !provider.starts_with("sftp:") || ids.contains(provider) {
                continue;
            }
            ids.push(provider.clone());
            let connection = self.get(provider)?;
            result.push(OperationConnection {
                resolved: connection.resolved.clone(),
                secrets: connection.auth.for_helper(&connection.resolved)?,
                root: connection.root.clone(),
                initial: connection.initial.clone(),
                home: connection.home.clone(),
            });
        }
        Ok(result)
    }

    pub(crate) fn from_operation_connections(
        inputs: Vec<OperationConnection>,
    ) -> Result<Arc<Self>, NativeError> {
        let manager = Self::new();
        for input in inputs {
            crate::filesystem::jobs::checkpoint()?;
            let auth = AuthContext::new(manager.credentials.clone(), input.secrets);
            let session = connect_session(&input.resolved, &auth).map_err(|e| e.error)?;
            let sftp = session.sftp().map_err(sftp_error)?;
            manager.connections.lock().unwrap().insert(
                input.resolved.profile.id.clone(),
                Arc::new(RemoteConnection {
                    profile: input.resolved.profile.clone(),
                    resolved: input.resolved,
                    auth,
                    session,
                    sftp,
                    root: input.root,
                    initial: input.initial,
                    home: input.home,
                    connected: AtomicBool::new(true),
                    app: None,
                }),
            );
        }
        Ok(manager)
    }

    pub fn create_terminal(
        self: &Arc<Self>,
        app: AppHandle,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(String, String), NativeError> {
        let connection = self.ensure(&format!("sftp:{connection_id}"))?;
        let _guard = self
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !Arc::ptr_eq(&connection, &self.get(&format!("sftp:{connection_id}"))?) {
            return Err(NativeError::new(
                "ESSH_DISCONNECTED",
                "The connection profile changed. Reconnect before opening a terminal.",
            ));
        }
        let resolved = ssh_config::resolve_profile(&connection.profile)?;
        let session = connect_session(&resolved, &connection.auth).map_err(|e| e.error)?;
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
    fn emit(&self, event: &str, payload: serde_json::Value) -> tauri::Result<()> {
        if let Some(app) = &self.app {
            app.emit(event, payload)
        } else {
            Ok(())
        }
    }

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
                #[cfg(target_os = "windows")]
                cloud_sync: None,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                content_availability: None,
            });
        }
        result.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(result)
    }
    fn read_text(
        &self,
        requested: &str,
        max_bytes: Option<u64>,
        strict_text: bool,
    ) -> Result<(String, Option<String>), NativeError> {
        let path = self.resolve(requested)?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        let limit = crate::filesystem::text::read_limit(max_bytes);
        if stat.size.unwrap_or(0) > limit {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 10 MB cannot be opened in the editor",
            ));
        }
        let file = self.sftp.open(Path::new(&path)).map_err(sftp_error)?;
        let content = if strict_text {
            crate::filesystem::text::read_bounded(file, limit, true)?
        } else {
            // Preserve the normal SFTP editor's UTF-8 decoding contract.
            let mut content = String::new();
            file.take(limit + 1)
                .read_to_string(&mut content)
                .map_err(|e| NativeError::from_io(&e, "Unable to read remote text"))?;
            if content.len() as u64 > limit {
                return Err(NativeError::new(
                    "EFILE_TOO_LARGE",
                    "Text file exceeds the read limit",
                ));
            }
            content
        };
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
    fn read_binary(&self, requested: &str) -> Result<(Vec<u8>, Option<String>), NativeError> {
        let path = self.resolve(requested)?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        if stat.size.unwrap_or(0) > 32 * 1024 * 1024 {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 32 MB cannot be opened",
            ));
        }
        let file = self.sftp.open(Path::new(&path)).map_err(sftp_error)?;
        let mut bytes = Vec::new();
        file.take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| NativeError::from_io(&e, "Unable to read remote file"))?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 32 MB cannot be opened",
            ));
        }
        Ok((
            bytes,
            stat.mtime
                .and_then(|v| chrono::DateTime::from_timestamp(v as i64, 0))
                .map(|v| v.to_rfc3339()),
        ))
    }

    fn write_binary(&self, requested: &str, bytes: &[u8]) -> Result<Option<String>, NativeError> {
        let path = self.resolve(requested)?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        if stat.size.unwrap_or(0) > 32 * 1024 * 1024 || bytes.len() > 32 * 1024 * 1024 {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 32 MB cannot be saved",
            ));
        }
        let mut file = self.sftp.create(Path::new(&path)).map_err(sftp_error)?;
        file.write_all(bytes)
            .map_err(|e| NativeError::from_io(&e, "Unable to save remote file"))?;
        let stat = self.sftp.stat(Path::new(&path)).map_err(sftp_error)?;
        Ok(stat
            .mtime
            .and_then(|v| chrono::DateTime::from_timestamp(v as i64, 0))
            .map(|v| v.to_rfc3339()))
    }

    fn remove(&self, requested: &str) -> Result<(), NativeError> {
        crate::filesystem::jobs::checkpoint()?;
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

impl RemoteEndpoint for RemoteConnection {
    fn resolve(&self, requested: &str) -> Result<String, NativeError> {
        RemoteConnection::resolve(self, requested)
    }
    fn is_directory(&self, path: &str) -> Result<bool, NativeError> {
        Ok(is_directory(
            &self.sftp.lstat(Path::new(path)).map_err(sftp_error)?,
        ))
    }
    fn child_names(&self, path: &str) -> Result<Vec<String>, NativeError> {
        Ok(self
            .sftp
            .readdir(Path::new(path))
            .map_err(sftp_error)?
            .into_iter()
            .filter_map(|(p, _)| p.file_name().and_then(|v| v.to_str()).map(str::to_string))
            .filter(|v| v != "." && v != "..")
            .collect())
    }
    fn open_read(&self, path: &str) -> Result<Box<dyn Read + '_>, NativeError> {
        Ok(Box::new(
            self.sftp.open(Path::new(path)).map_err(sftp_error)?,
        ))
    }
    fn create_new(&self, path: &str) -> Result<Box<dyn Write + '_>, NativeError> {
        Ok(Box::new(
            self.sftp
                .open_mode(
                    Path::new(path),
                    OpenFlags::CREATE | OpenFlags::EXCLUSIVE | OpenFlags::WRITE,
                    0o644,
                    OpenType::File,
                )
                .map_err(sftp_error)?,
        ))
    }
    fn create_folder(&self, path: &str) -> Result<(), NativeError> {
        self.sftp.mkdir(Path::new(path), 0o755).map_err(sftp_error)
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), NativeError> {
        self.sftp
            .rename(Path::new(from), Path::new(to), None)
            .map_err(sftp_error)
    }
    fn remove(&self, requested: &str) -> Result<(), NativeError> {
        RemoteConnection::remove(self, requested)
    }
}

impl RemoteSessions for SshManager {
    fn endpoint(&self, provider_id: &str) -> Result<Arc<dyn RemoteEndpoint>, NativeError> {
        Ok(self.get(provider_id)?)
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
        #[cfg(target_os = "windows")]
        cloud_sync: None,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        content_availability: None,
    }
}

fn connect_session(
    resolved: &ResolvedProfile,
    context: &AuthContext,
) -> Result<Session, ConnectError> {
    let profile = &resolved.profile;
    let tcp =
        TcpStream::connect((profile.host.as_str(), profile.port)).map_err(|e| ConnectError {
            error: NativeError::from_io(&e, "Unable to connect to the SSH server"),
            host_key: None,
            auth: None,
        })?;
    tcp.set_read_timeout(Some(Duration::from_secs(20))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(20))).ok();
    let mut session = Session::new().map_err(|e| connect_native(e, "Unable to initialize SSH"))?;
    session.set_timeout(20_000);
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
                auth: None,
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
                auth: None,
            })
        }
        Some(expected) if expected != observed => {
            return Err(ConnectError {
                error: NativeError::new(
                    "EHOSTKEY_CHANGED",
                    "REMOTE HOST IDENTIFICATION HAS CHANGED",
                ),
                host_key: Some(info),
                auth: None,
            })
        }
        _ => {}
    }
    crate::ssh_auth::authenticate(
        &mut crate::ssh_auth::SshAuthSession::new(&session, &profile.username),
        resolved,
        context,
    )
    .map_err(|failure| ConnectError {
        error: failure.error,
        host_key: None,
        auth: Some(failure.auth),
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
        || p.protocol != "sftp"
        || !["auto", "agent", "password", "privateKey"].contains(&p.auth_type.as_str())
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
fn remote_stat(
    name: String,
    path: String,
    stat: &FileStat,
    is_symbolic_link: bool,
) -> crate::shell_integration::transfer::RemoteStat {
    crate::shell_integration::transfer::RemoteStat {
        name,
        path,
        is_directory: is_directory(stat),
        is_symbolic_link,
        size: stat.size.unwrap_or(0),
        modified: stat.mtime.map(|value| value as i64),
    }
}

fn is_directory(stat: &FileStat) -> bool {
    stat.perm.unwrap_or(0) & TYPE_MASK == DIRECTORY_MODE
}
fn properties_sftp_error(error: ssh2::Error) -> NativeError {
    let (code, message) = match error.code() {
        ssh2::ErrorCode::SFTP(2) => ("ENOENT", "The remote item no longer exists"),
        ssh2::ErrorCode::SFTP(3) => ("EACCES", "Permission denied by the SFTP server"),
        ssh2::ErrorCode::SFTP(8) => (
            "ENOTSUPPORTED",
            "These attributes are not supported by the SFTP server",
        ),
        ssh2::ErrorCode::SFTP(6 | 7) | ssh2::ErrorCode::Session(_) => (
            "ESSH_DISCONNECTED",
            "The SFTP connection was lost; reload properties to reconnect",
        ),
        _ => (
            "ESFTP_ATTRIBUTES",
            "The SFTP server could not inspect or change these attributes",
        ),
    };
    NativeError::new(code, message).with_native_error(error.to_string())
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
        auth: None,
    }
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
            protocol: "sftp".into(),
            save_password: false,
            save_key_passphrase: false,
            ssh_config_host: String::new(),
            private_key_path: Some("/keys/id_ed25519".into()),
            initial_path: Some("/home/demo".into()),
            trusted_fingerprint: None,
            ftp_tls: String::new(),
            ftp_data_mode: String::new(),
            ftp_encoding: String::new(),
            tls_trusted_certificate: String::new(),
            plaintext_acknowledged: false,
        };
        assert!(validate_profile(&profile).is_ok());
        // SSH commands accept SFTP profiles only; FTP/FTPS are never SSH.
        for protocol in ["ftp", "ftps", "", "unknown"] {
            let mut other = profile.clone();
            other.protocol = protocol.into();
            other.auth_type = "password".into();
            assert_eq!(validate_profile(&other).unwrap_err().code, "EINVAL");
        }
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
