//! Native FTP and FTPS (explicit and implicit TLS) client support.
//!
//! `FtpManager` owns the connected FTP and FTPS profiles of the application
//! (and, inside the filesystem helper, of one operation). Provider ids are
//! `ftp:<profile-id>` and `ftps:<profile-id>`; the scheme must match the
//! saved profile's protocol. Sessions are pooled per profile (see `pool`).
pub mod connection;
pub mod errors;
pub mod listing;
pub mod pool;
pub mod tls;

#[cfg(test)]
mod library_contract_tests;
#[cfg(test)]
mod manager_tests;
#[cfg(test)]
mod test_certs;
#[cfg(test)]
pub mod test_server;

use crate::{
    connections::ConnectionProfile,
    credential_store::{CredentialKind, CredentialStore},
    error::NativeError,
    filesystem::{
        properties::{Capabilities as PropertyCapabilities, Properties},
        remote_ops::{RemoteEndpoint, TransferRead, TransferWrite},
        FileEntry,
    },
    remote::{SizeChild, SizeChildKind},
    shell_integration::transfer::RemoteStat,
};
use connection::{ConnectFailure, FtpSession};
use listing::{EntryKind, FtpEntry};
use pool::{Credentials, FtpConnection, FtpReader, FtpWriter};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn root_entry() -> FtpEntry {
    FtpEntry {
        name: "/".into(),
        kind: EntryKind::Directory,
        size: None,
        modified: None,
    }
}

pub(crate) fn remote_name(value: &str) -> &str {
    crate::filesystem::remote_ops::remote_name(value)
}
pub(crate) fn remote_parent(value: &str) -> String {
    crate::filesystem::remote_ops::remote_parent(value)
}
fn remote_join(a: &str, b: &str) -> String {
    crate::filesystem::remote_ops::remote_join(a, b)
}

/// Absolute POSIX path without `.`/`..`, NUL or line breaks (which would
/// end an FTP command).
pub fn normalize_path(value: &str) -> Result<String, NativeError> {
    if !value.starts_with('/') || value.contains(['\\', '\0', '\r', '\n']) {
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

fn time_string(seconds: Option<i64>) -> Option<String> {
    seconds
        .and_then(|value| chrono::DateTime::from_timestamp(value, 0))
        .map(|time| time.to_rfc3339())
}

fn file_entry(directory: &str, entry: &FtpEntry) -> FileEntry {
    let is_directory = entry.kind == EntryKind::Directory;
    FileEntry {
        name: entry.name.clone(),
        path: remote_join(directory, &entry.name),
        entry_type: if is_directory { "directory" } else { "file" },
        is_directory,
        is_symbolic_link: entry.kind == EntryKind::Symlink,
        size: entry.size,
        modified_at: time_string(entry.modified),
        metadata_error: None,
        #[cfg(target_os = "windows")]
        cloud_sync: None,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        content_availability: None,
    }
}

fn not_found(path: &str) -> NativeError {
    NativeError::new("ENOENT", "The remote item no longer exists").with_path(path)
}

/// Validates a saved FTP/FTPS profile before any network use.
pub fn validate_profile(profile: &ConnectionProfile) -> Result<(), NativeError> {
    let invalid = || NativeError::new("EINVAL", "Invalid FTP connection profile");
    if profile.id.is_empty()
        || profile.id.len() > 80
        || !profile
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        || !matches!(profile.protocol.as_str(), "ftp" | "ftps")
        || profile.host.trim().is_empty()
        || profile.host.contains(['\r', '\n', '\0'])
        || profile.username.is_empty()
        || profile.username.contains(['\r', '\n', '\0'])
        || profile.port == 0
        || !matches!(profile.auth_type.as_str(), "password" | "anonymous")
        || (profile.protocol == "ftps"
            && !matches!(profile.ftp_tls.as_str(), "explicit" | "implicit"))
    {
        return Err(invalid());
    }
    if let Some(path) = profile.initial_path.as_deref().filter(|p| !p.is_empty()) {
        normalize_path(path)?;
    }
    Ok(())
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
    pub capabilities: serde_json::Value,
}

/// A connection snapshot for the filesystem helper. Sent only over the
/// helper's private stdin pipe; the password is the resolved session secret.
#[derive(Serialize, Deserialize)]
pub struct FtpOperationConnection {
    profile: ConnectionProfile,
    password: Zeroizing<String>,
    root: String,
    initial: String,
    home: String,
}

pub struct FtpManager {
    pub credentials: Arc<CredentialStore>,
    profile_updates: Arc<Mutex<()>>,
    settings: Option<Arc<crate::settings::SettingsStore>>,
    connections: Mutex<HashMap<String, Arc<FtpConnection>>>,
    /// Extra trust anchors, for tests.
    extra_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
}

impl FtpManager {
    pub fn new(
        credentials: Arc<CredentialStore>,
        profile_updates: Arc<Mutex<()>>,
        settings: Option<Arc<crate::settings::SettingsStore>>,
    ) -> Arc<Self> {
        let manager = Arc::new(Self {
            credentials,
            profile_updates,
            settings,
            connections: Mutex::new(HashMap::new()),
            extra_roots: vec![],
        });
        let weak = Arc::downgrade(&manager);
        thread::spawn(move || loop {
            thread::sleep(KEEPALIVE_INTERVAL);
            let Some(manager) = weak.upgrade() else { break };
            let connections: Vec<_> = manager
                .connections
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .cloned()
                .collect();
            drop(manager);
            for connection in connections {
                connection.keepalive();
            }
        });
        manager
    }

    #[cfg(test)]
    pub fn with_roots(
        credentials: Arc<CredentialStore>,
        settings: Option<Arc<crate::settings::SettingsStore>>,
        roots: Vec<rustls::pki_types::CertificateDer<'static>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            credentials,
            profile_updates: Arc::new(Mutex::new(())),
            settings,
            connections: Mutex::new(HashMap::new()),
            extra_roots: roots,
        })
    }

    fn saved_profile(&self, profile_id: &str) -> Result<ConnectionProfile, NativeError> {
        let settings = self
            .settings
            .as_ref()
            .ok_or_else(|| NativeError::new("ENOENT", "The connection profile was not found"))?
            .load()?;
        let value = settings["connections"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == profile_id))
            .ok_or_else(|| NativeError::new("ENOENT", "The connection profile was not found"))?;
        serde_json::from_value(value.clone())
            .map_err(|_| NativeError::new("EINVAL", "Invalid FTP connection profile"))
    }

    /// Connects a **saved** profile. Its settings, not the request, decide the
    /// endpoint, TLS mode, pin, plaintext acknowledgement and whether a saved
    /// password may be used. `password` is an optional typed secret.
    pub fn connect(
        &self,
        app: Option<AppHandle>,
        profile_id: &str,
        password: Zeroizing<String>,
    ) -> Result<ConnectResult, ConnectFailure> {
        let _guard = self
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let profile = self.saved_profile(profile_id)?;
        validate_profile(&profile)?;
        if profile.protocol == "ftp" && !profile.plaintext_acknowledged {
            return Err(NativeError::new(
                "EFTP_PLAINTEXT_NOT_ACKNOWLEDGED",
                "Confirm that this FTP connection sends the password and files unencrypted",
            )
            .into());
        }
        let credentials = Credentials {
            transient: password,
            store: Some(Arc::clone(&self.credentials)),
        };
        let typed = !credentials.transient.is_empty();
        let spec = connection::ConnectSpec {
            host: profile.host.clone(),
            port: profile.port,
            security: pool::security(&profile),
            username: profile.username.clone(),
            password: credentials
                .password(&profile)
                .map_err(|error| ConnectFailure {
                    error,
                    certificate: None,
                    authentication: true,
                })?,
            pin: Some(profile.tls_trusted_certificate.clone()).filter(|p| !p.is_empty()),
            extra_roots: self.extra_roots.clone(),
        };
        let mut session = FtpSession::connect(&spec)?;
        let home = session
            .pwd()
            .ok()
            .and_then(|path| normalize_path(&path).ok())
            .unwrap_or_else(|| "/".into());
        let initial = normalize_path(
            profile
                .initial_path
                .as_deref()
                .filter(|path| !path.is_empty())
                .unwrap_or(&home),
        )?;
        match session.stat(&initial).map_err(|(error, _)| error)? {
            Some(entry) if entry.kind == EntryKind::Directory => {}
            Some(_) => {
                return Err(
                    NativeError::new("ENOTDIR", "Initial remote path is not a folder").into(),
                )
            }
            None => {
                return Err(
                    NativeError::new("ENOENT", "Initial remote directory was not found")
                        .with_path(&initial)
                        .into(),
                )
            }
        }
        // Saved only now: after TLS verification, authentication and the
        // initial directory check, and only when the profile asks for it.
        let mut credentials = credentials;
        let mut credential_warning = None;
        if typed && profile.save_password && profile.permits_password() {
            match self
                .credentials
                .set(&profile, CredentialKind::Password, &credentials.transient)
            {
                Ok(()) => credentials.transient = Zeroizing::new(String::new()),
                Err(error) => credential_warning = Some(error),
            }
        }
        let capabilities = serde_json::json!({
            "mlsd": session.capabilities.mlsd, "utf8": session.capabilities.utf8,
            "rest": session.capabilities.rest, "changePermissions": false, "terminal": false,
            "symlinkCreate": false, "atomicCreate": false,
        });
        let connection = FtpConnection::new(
            profile.clone(),
            credentials,
            session,
            ("/".into(), initial.clone(), home.clone()),
            self.extra_roots.clone(),
        );
        if let Some(previous) = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(profile.id.clone(), connection)
        {
            previous.close();
        }
        let provider_id = format!("{}:{}", profile.protocol, profile.id);
        if let Some(app) = app {
            let _ = app.emit(
                "ftp:status",
                serde_json::json!({"connectionId": profile.id, "providerId": provider_id, "status": "connected"}),
            );
        }
        Ok(ConnectResult {
            connection_id: profile.id.clone(),
            provider_id,
            status: "connected",
            root: directory_entry("/"),
            initial: directory_entry(&initial),
            home_path: home,
            credential_warning,
            capabilities,
        })
    }

    pub fn disconnect(&self, profile_id: &str) {
        if let Some(connection) = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(profile_id)
        {
            connection.close();
        }
    }

    pub fn status(&self, profile_id: &str) -> &'static str {
        if self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(profile_id)
            .is_some_and(|c| c.is_connected())
        {
            "connected"
        } else {
            "disconnected"
        }
    }

    pub fn shutdown(&self) {
        let connections: Vec<_> = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, c)| c)
            .collect();
        for connection in connections {
            connection.close();
        }
    }

    /// The connection for `ftp:<id>` or `ftps:<id>`; the scheme must match
    /// the connected profile's protocol.
    pub fn get(&self, provider_id: &str) -> Result<Arc<FtpConnection>, NativeError> {
        let (scheme, id) = provider_id
            .split_once(':')
            .filter(|(scheme, _)| matches!(*scheme, "ftp" | "ftps"))
            .ok_or_else(crate::remote::unavailable)?;
        let connection = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(pool::disconnected)?;
        if connection.profile.protocol != scheme {
            return Err(crate::remote::unavailable());
        }
        if !connection.is_connected() {
            return Err(pool::disconnected());
        }
        Ok(connection)
    }

    pub fn operation_connections(
        &self,
        providers: &[&str],
    ) -> Result<Vec<FtpOperationConnection>, NativeError> {
        let _guard = self
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<&str> = vec![];
        let mut result = vec![];
        for provider in providers {
            if ids.contains(provider) {
                continue;
            }
            ids.push(provider);
            let connection = self.get(provider)?;
            result.push(FtpOperationConnection {
                profile: connection.profile.clone(),
                password: connection.credentials.password(&connection.profile)?,
                root: connection.root.clone(),
                initial: connection.initial.clone(),
                home: connection.home.clone(),
            });
        }
        Ok(result)
    }

    /// Inside the filesystem helper: one connection per snapshot. Each one
    /// verifies TLS and the certificate pin itself before sending the password.
    pub fn from_operation_connections(
        inputs: Vec<FtpOperationConnection>,
    ) -> Result<Arc<Self>, NativeError> {
        let manager = Arc::new(Self {
            credentials: CredentialStore::native(),
            profile_updates: Arc::new(Mutex::new(())),
            settings: None,
            connections: Mutex::new(HashMap::new()),
            extra_roots: vec![],
        });
        for input in inputs {
            crate::filesystem::jobs::checkpoint()?;
            validate_profile(&input.profile)?;
            let credentials = Credentials {
                transient: input.password,
                store: None,
            };
            let spec = connection::ConnectSpec {
                host: input.profile.host.clone(),
                port: input.profile.port,
                security: pool::security(&input.profile),
                username: input.profile.username.clone(),
                password: credentials.password(&input.profile)?,
                pin: Some(input.profile.tls_trusted_certificate.clone()).filter(|p| !p.is_empty()),
                extra_roots: vec![],
            };
            let session = FtpSession::connect(&spec).map_err(|failure| failure.error)?;
            manager.connections.lock().unwrap().insert(
                input.profile.id.clone(),
                FtpConnection::new(
                    input.profile,
                    credentials,
                    session,
                    (input.root, input.initial, input.home),
                    vec![],
                ),
            );
        }
        Ok(manager)
    }
}

fn directory_entry(path: &str) -> FileEntry {
    let mut entry = file_entry(
        &remote_parent(path),
        &FtpEntry {
            name: remote_name(path).to_string(),
            kind: EntryKind::Directory,
            size: None,
            modified: None,
        },
    );
    entry.path = path.to_string();
    entry
}

/// Provider operations of one connected profile.
impl FtpConnection {
    pub fn resolve(&self, requested: &str) -> Result<String, NativeError> {
        let path = normalize_path(requested)?;
        let root = self.root.trim_end_matches('/');
        if path != self.root && !path.starts_with(&format!("{root}/")) {
            return Err(NativeError::new(
                "EOUTSIDE_ROOT",
                "Path is outside this remote connection root",
            ));
        }
        Ok(path)
    }

    pub fn root_entries(&self) -> (FileEntry, FileEntry, String) {
        (
            directory_entry(&self.root),
            directory_entry(&self.initial),
            self.home.clone(),
        )
    }

    pub fn list(self: &Arc<Self>, requested: &str) -> Result<Vec<FileEntry>, NativeError> {
        let directory = self.resolve(requested)?;
        let entries = self.repeatable(|session| session.list(&directory))?;
        Ok(entries
            .iter()
            .map(|entry| file_entry(&directory, entry))
            .collect())
    }

    pub fn stat_entry(self: &Arc<Self>, requested: &str) -> Result<Option<FtpEntry>, NativeError> {
        let path = self.resolve(requested)?;
        self.repeatable(|session| session.stat(&path))
    }

    fn require(self: &Arc<Self>, path: &str) -> Result<FtpEntry, NativeError> {
        self.stat_entry(path)?.ok_or_else(|| not_found(path))
    }

    pub fn read_text(
        self: &Arc<Self>,
        requested: &str,
        max_bytes: Option<u64>,
        strict_text: bool,
    ) -> Result<(String, Option<String>), NativeError> {
        let path = self.resolve(requested)?;
        let entry = self.require(&path)?;
        if entry.kind == EntryKind::Directory {
            return Err(NativeError::new("EISDIR", "This item is not a text file"));
        }
        let limit = crate::filesystem::text::read_limit(max_bytes).min(MAX_TEXT_BYTES);
        if entry.size.is_some_and(|size| size > limit) {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Text file exceeds the read limit",
            ));
        }
        let bytes = self.read_bytes(&path, limit)?;
        let text = crate::filesystem::text::read_bounded(bytes.as_slice(), limit, strict_text)?;
        Ok((text, time_string(entry.modified)))
    }

    /// Downloads a file into memory, failing above `limit`.
    fn read_bytes(self: &Arc<Self>, path: &str, limit: u64) -> Result<Vec<u8>, NativeError> {
        let mut reader = self.download(path)?;
        let mut bytes = vec![];
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|e| errors::io_error(&e, path, "The FTP download failed"))?;
            if read == 0 {
                break;
            }
            if bytes.len() as u64 + read as u64 > limit {
                drop(reader);
                return Err(NativeError::new(
                    "EFILE_TOO_LARGE",
                    "The file exceeds the read limit",
                ));
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        reader.finish()?;
        Ok(bytes)
    }

    /// Replaces a file's content (editor save). FTP has no atomic replace.
    fn write_bytes(
        self: &Arc<Self>,
        requested: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, NativeError> {
        let path = self.resolve(requested)?;
        let mut writer = self.upload(&path)?;
        if let Err(error) = writer.write_all(bytes).and_then(|_| writer.flush()) {
            writer.abort();
            return Err(errors::io_error(&error, &path, "The FTP upload failed"));
        }
        writer.finish()?;
        Ok(self
            .stat_entry(&path)
            .ok()
            .flatten()
            .and_then(|e| time_string(e.modified)))
    }

    pub fn write_text(
        self: &Arc<Self>,
        requested: &str,
        content: &str,
    ) -> Result<Option<String>, NativeError> {
        if content.len() as u64 > MAX_TEXT_BYTES {
            return Err(NativeError::new(
                "EFILE_TOO_LARGE",
                "Files larger than 10 MB cannot be opened in the editor",
            ));
        }
        self.write_bytes(requested, content.as_bytes())
    }

    pub fn read_binary(
        self: &Arc<Self>,
        requested: &str,
    ) -> Result<(Vec<u8>, Option<String>), NativeError> {
        let path = self.resolve(requested)?;
        let entry = self.require(&path)?;
        if entry.kind == EntryKind::Directory {
            return Err(NativeError::new("EISDIR", "This item is not a file"));
        }
        Ok((
            self.read_bytes(&path, MAX_BINARY_BYTES)?,
            time_string(entry.modified),
        ))
    }

    pub fn write_binary(
        self: &Arc<Self>,
        requested: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, NativeError> {
        self.write_bytes(requested, bytes)
    }

    pub fn properties(self: &Arc<Self>, requested: &str) -> Result<Properties, NativeError> {
        let path = self.resolve(requested)?;
        let entry = self.require(&path)?;
        let kind = match entry.kind {
            EntryKind::Directory => "directory",
            EntryKind::File => "file",
            EntryKind::Symlink => "symlink",
            EntryKind::Unknown => "unknown",
        };
        Ok(Properties {
            name: remote_name(&path).to_string(),
            path: path.clone(),
            entry_type: kind,
            size: (kind != "directory").then_some(entry.size).flatten(),
            created_at: None,
            modified_at: time_string(entry.modified),
            accessed_at: None,
            target: None,
            permissions: None,
            permissions_message: Some("Permissions are not available over FTP"),
            capabilities: PropertyCapabilities {
                calculate_size: kind == "directory",
                change_mode: false,
                change_owner: false,
                change_group: false,
                preview: kind == "file",
            },
            metadata_warnings: vec![],
            content_availability: None,
            cloud_sync: None,
        })
    }

    pub fn size_children(self: &Arc<Self>, requested: &str) -> Result<Vec<SizeChild>, NativeError> {
        let directory = self.resolve(requested)?;
        let entries = self.repeatable(|session| session.list(&directory))?;
        Ok(entries
            .into_iter()
            .map(|entry| SizeChild {
                path: remote_join(&directory, &entry.name),
                kind: match entry.kind {
                    EntryKind::Directory => SizeChildKind::Directory,
                    // Links are counted, never followed.
                    EntryKind::File | EntryKind::Symlink => SizeChildKind::File,
                    EntryKind::Unknown => SizeChildKind::Other,
                },
                size: entry.size,
            })
            .collect())
    }

    pub fn remote_stat(self: &Arc<Self>, requested: &str) -> Result<RemoteStat, NativeError> {
        let path = self.resolve(requested)?;
        let entry = self.require(&path)?;
        Ok(remote_stat(&path, &entry))
    }

    pub fn remote_children(
        self: &Arc<Self>,
        requested: &str,
    ) -> Result<Vec<RemoteStat>, NativeError> {
        let directory = self.resolve(requested)?;
        let entries = self.repeatable(|session| session.list(&directory))?;
        Ok(entries
            .iter()
            .map(|entry| remote_stat(&remote_join(&directory, &entry.name), entry))
            .collect())
    }

    /// A download for plain `Read` consumers (clipboard, drag-and-drop):
    /// the final reply is checked at end-of-file.
    pub fn open_reader(self: &Arc<Self>, requested: &str) -> Result<FtpReader, NativeError> {
        let path = self.resolve(requested)?;
        Ok(self.download(&path)?.complete_at_end())
    }
}

fn remote_stat(path: &str, entry: &FtpEntry) -> RemoteStat {
    RemoteStat {
        name: remote_name(path).to_string(),
        path: path.to_string(),
        is_directory: entry.kind == EntryKind::Directory,
        is_symbolic_link: entry.kind == EntryKind::Symlink,
        size: entry.size.unwrap_or(0),
        modified: entry.modified,
    }
}

impl TransferRead for FtpReader {
    fn finish(self: Box<Self>) -> Result<(), NativeError> {
        FtpReader::finish(*self)
    }
}
impl TransferWrite for FtpWriter {
    fn finish(self: Box<Self>) -> Result<(), NativeError> {
        FtpWriter::finish(*self)
    }
    fn abort(self: Box<Self>) {
        FtpWriter::abort(*self)
    }
}

/// File operations in the filesystem helper.
impl RemoteEndpoint for Arc<FtpConnection> {
    fn resolve(&self, requested: &str) -> Result<String, NativeError> {
        FtpConnection::resolve(self, requested)
    }
    fn is_directory(&self, path: &str) -> Result<bool, NativeError> {
        Ok(self.require(path)?.kind == EntryKind::Directory)
    }
    fn child_names(&self, path: &str) -> Result<Vec<String>, NativeError> {
        Ok(self
            .repeatable(|session| session.list(path))?
            .into_iter()
            .map(|entry| entry.name)
            .collect())
    }
    fn open_read(&self, path: &str) -> Result<Box<dyn TransferRead + '_>, NativeError> {
        Ok(Box::new(self.download(path)?))
    }
    fn create_new(&self, path: &str) -> Result<Box<dyn TransferWrite + '_>, NativeError> {
        // FTP has no exclusive create: check first; another client could
        // still create the same name before STOR.
        if self.stat_entry(path)?.is_some() {
            return Err(
                NativeError::new("EEXIST", "An item with this name already exists").with_path(path),
            );
        }
        Ok(Box::new(self.upload(path)?))
    }
    fn create_folder(&self, path: &str) -> Result<(), NativeError> {
        if self.stat_entry(path)?.is_some() {
            return Err(
                NativeError::new("EEXIST", "An item with this name already exists").with_path(path),
            );
        }
        self.once(|session| session.mkdir(path))
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), NativeError> {
        // Servers differ on renaming over an existing item; never rely on it.
        if self.stat_entry(to)?.is_some() {
            return Err(
                NativeError::new("EEXIST", "An item with this name already exists").with_path(to),
            );
        }
        self.once(|session| session.rename(from, to))
    }
    fn remove(&self, requested: &str) -> Result<(), NativeError> {
        crate::filesystem::jobs::checkpoint()?;
        let path = FtpConnection::resolve(self, requested)?;
        if path == self.root {
            return Err(NativeError::new(
                "EROOT_OPERATION",
                "The remote root cannot be removed",
            ));
        }
        let entry = self.require(&path)?;
        if entry.kind == EntryKind::Directory {
            // Links and unknown entries are deleted, never followed.
            for child in self.repeatable(|session| session.list(&path))? {
                self.remove(&remote_join(&path, &child.name))?;
            }
            self.once(|session| session.rmdir(&path))
        } else {
            self.once(|session| session.delete(&path))
        }
    }
}
