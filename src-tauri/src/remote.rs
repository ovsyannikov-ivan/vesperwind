//! Provider identity and dispatch for non-local filesystems.
//!
//! A provider id is `local` or `<scheme>:<connection-id>`. Only schemes with
//! a registered protocol are accepted; anything else is `EFILESYSTEM_ID` and
//! never reaches a protocol manager. Each protocol keeps its own connection,
//! authentication and reconnect policy; this module only routes requests.
use crate::{
    error::NativeError,
    filesystem::{
        operations::OperationRequest,
        properties::{PermissionUpdate, Properties},
        remote_ops::{RemoteEndpoint, RemoteSessions},
        FileEntry,
    },
    shell_integration::transfer::RemoteStat,
    ssh::{OperationConnection, SshManager},
};
use serde::{Deserialize, Serialize};
use std::{io::Read, sync::Arc};

pub const LOCAL_PROVIDER: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteProtocol {
    Sftp,
}

impl RemoteProtocol {
    const ALL: [Self; 1] = [Self::Sftp];

    pub fn scheme(self) -> &'static str {
        match self {
            Self::Sftp => "sftp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRef<'a> {
    Local,
    Remote {
        protocol: RemoteProtocol,
        connection_id: &'a str,
    },
}

pub fn unavailable() -> NativeError {
    NativeError::new("EFILESYSTEM_ID", "This filesystem is not available")
}

/// A missing id means the local filesystem, matching the existing payloads.
pub fn parse_provider(provider_id: Option<&str>) -> Result<ProviderRef<'_>, NativeError> {
    let Some(provider_id) = provider_id else {
        return Ok(ProviderRef::Local);
    };
    if provider_id == LOCAL_PROVIDER {
        return Ok(ProviderRef::Local);
    }
    let (scheme, connection_id) = provider_id.split_once(':').ok_or_else(unavailable)?;
    let protocol = RemoteProtocol::ALL
        .into_iter()
        .find(|protocol| protocol.scheme() == scheme)
        .ok_or_else(unavailable)?;
    // Same identity rule as saved connection profiles and credential ids.
    if connection_id.is_empty()
        || connection_id.len() > 80
        || !connection_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(unavailable());
    }
    Ok(ProviderRef::Remote {
        protocol,
        connection_id,
    })
}

/// Child entry for size calculation, independent of protocol stat formats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizeChild {
    pub path: String,
    pub kind: SizeChildKind,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeChildKind {
    Directory,
    /// Regular files and links are counted by their reported size.
    File,
    Other,
}

/// Connection snapshots handed to the filesystem helper. The serialized
/// field names keep the existing helper frame (`remote` holds SFTP entries).
#[derive(Default, Serialize, Deserialize)]
pub struct OperationConnections {
    #[serde(rename = "remote", default)]
    pub(crate) sftp: Vec<OperationConnection>,
}

impl OperationConnections {
    pub fn is_empty(&self) -> bool {
        self.sftp.is_empty()
    }

    /// Opens the helper's own sessions. Runs only inside the filesystem
    /// helper; every protocol re-verifies its server identity here.
    pub fn open(self) -> Result<HelperSessions, NativeError> {
        Ok(HelperSessions {
            ssh: SshManager::from_operation_connections(self.sftp)?,
        })
    }
}

/// Remote connections opened by one filesystem helper.
pub struct HelperSessions {
    ssh: Arc<SshManager>,
}

impl RemoteSessions for HelperSessions {
    fn endpoint(&self, provider_id: &str) -> Result<Arc<dyn RemoteEndpoint>, NativeError> {
        match parse_provider(Some(provider_id))? {
            ProviderRef::Remote {
                protocol: RemoteProtocol::Sftp,
                ..
            } => self.ssh.endpoint(provider_id),
            ProviderRef::Local => Err(unavailable()),
        }
    }
}

/// Routes provider-scoped requests to the protocol that owns the provider id.
#[derive(Clone)]
pub struct RemoteProviders {
    ssh: Arc<SshManager>,
}

enum Backend<'a> {
    Sftp(&'a Arc<SshManager>),
}

impl RemoteProviders {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh }
    }

    fn backend(&self, provider_id: &str) -> Result<Backend<'_>, NativeError> {
        match parse_provider(Some(provider_id))? {
            ProviderRef::Remote {
                protocol: RemoteProtocol::Sftp,
                ..
            } => Ok(Backend::Sftp(&self.ssh)),
            ProviderRef::Local => Err(unavailable()),
        }
    }

    pub fn root(&self, provider: &str) -> Result<(FileEntry, FileEntry, String), NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.root(provider),
        }
    }

    pub fn list(&self, provider: &str, path: &str) -> Result<Vec<FileEntry>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.list(provider, path),
        }
    }

    pub fn resolve_path(&self, provider: &str, path: &str) -> Result<String, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.resolve_path(provider, path),
        }
    }

    pub fn read_text(
        &self,
        provider: &str,
        path: &str,
        max_bytes: Option<u64>,
        strict_text: bool,
    ) -> Result<(String, Option<String>), NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.read_text(provider, path, max_bytes, strict_text),
        }
    }

    pub fn write_text(
        &self,
        provider: &str,
        path: &str,
        content: &str,
    ) -> Result<Option<String>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.write_text(provider, path, content),
        }
    }

    pub fn read_binary(
        &self,
        provider: &str,
        path: &str,
    ) -> Result<(Vec<u8>, Option<String>), NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.read_binary(provider, path),
        }
    }

    pub fn write_binary(
        &self,
        provider: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.write_binary(provider, path, bytes),
        }
    }

    pub fn properties(&self, provider: &str, path: &str) -> Result<Properties, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.properties(provider, path),
        }
    }

    pub fn update_properties(
        &self,
        provider: &str,
        path: &str,
        update: &PermissionUpdate,
    ) -> Result<Properties, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.update_properties(provider, path, update),
        }
    }

    pub fn size_children(
        &self,
        provider: &str,
        directory: &str,
    ) -> Result<Vec<SizeChild>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => Ok(ssh
                .size_children(provider, directory)?
                .into_iter()
                .map(|(path, stat)| SizeChild {
                    path,
                    kind: match stat.perm.map(|mode| mode & 0o170000) {
                        Some(0o040000) => SizeChildKind::Directory,
                        Some(0o100000 | 0o120000) => SizeChildKind::File,
                        _ => SizeChildKind::Other,
                    },
                    size: stat.size,
                })
                .collect()),
        }
    }

    pub fn stat(&self, provider: &str, path: &str) -> Result<RemoteStat, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.remote_stat(provider, path),
        }
    }

    pub fn children(&self, provider: &str, path: &str) -> Result<Vec<RemoteStat>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => ssh.remote_children(provider, path),
        }
    }

    pub fn open_read(
        &self,
        provider: &str,
        path: &str,
    ) -> Result<Box<dyn Read + Send>, NativeError> {
        match self.backend(provider)? {
            Backend::Sftp(ssh) => Ok(Box::new(ssh.open_content_stream(provider, path)?)),
        }
    }

    /// Validates both providers before any helper starts, then collects the
    /// private connection snapshots each remote protocol needs.
    pub fn operation_connections(
        &self,
        request: &OperationRequest,
    ) -> Result<OperationConnections, NativeError> {
        parse_provider(request.filesystem_id.as_deref())?;
        parse_provider(request.target_filesystem_id.as_deref())?;
        Ok(OperationConnections {
            sftp: self.ssh.operation_connections(request)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_missing_ids_route_to_the_local_provider() {
        assert_eq!(parse_provider(None).unwrap(), ProviderRef::Local);
        assert_eq!(parse_provider(Some("local")).unwrap(), ProviderRef::Local);
    }

    #[test]
    fn sftp_ids_keep_their_existing_contract() {
        assert_eq!(
            parse_provider(Some("sftp:profile-1.a_b")).unwrap(),
            ProviderRef::Remote {
                protocol: RemoteProtocol::Sftp,
                connection_id: "profile-1.a_b"
            }
        );
    }

    #[test]
    fn unknown_or_malformed_ids_are_rejected_without_reaching_a_protocol() {
        for id in [
            "",
            "LOCAL",
            "sftp",
            "sftp:",
            "sftp:../x",
            "sftp:a/b",
            "sftp:a:b",
            "ftp:demo",
            "ftps:demo",
            "smb:demo",
            "SFTP:demo",
        ] {
            assert_eq!(parse_provider(Some(id)).unwrap_err().code, "EFILESYSTEM_ID");
        }
        let long = format!("sftp:{}", "a".repeat(81));
        assert_eq!(
            parse_provider(Some(&long)).unwrap_err().code,
            "EFILESYSTEM_ID"
        );
    }

    #[test]
    fn dispatcher_rejects_local_and_unknown_ids_and_leaves_connections_untouched() {
        let ssh = SshManager::new();
        let providers = RemoteProviders::new(Arc::clone(&ssh));
        for id in ["local", "ftp:demo", "unknown"] {
            assert_eq!(providers.list(id, "/").unwrap_err().code, "EFILESYSTEM_ID");
            assert_eq!(
                providers.read_text(id, "/a", None, false).unwrap_err().code,
                "EFILESYSTEM_ID"
            );
            assert_eq!(providers.stat(id, "/a").unwrap_err().code, "EFILESYSTEM_ID");
        }
        // A registered scheme reaches its manager, which reports its own state.
        assert_eq!(
            providers.list("sftp:demo", "/").unwrap_err().code,
            "ESSH_DISCONNECTED"
        );
        assert_eq!(ssh.status("demo"), "disconnected");
    }

    #[test]
    fn operation_connections_validate_both_sides_and_keep_the_helper_frame() {
        let providers = RemoteProviders::new(SshManager::new());
        let request = |source: &str, target: Option<&str>| -> OperationRequest {
            serde_json::from_value(serde_json::json!({
                "action": "copy", "sourcePath": "/a", "targetDirectory": "/b",
                "filesystemId": source, "targetFilesystemId": target,
            }))
            .unwrap()
        };
        assert!(providers
            .operation_connections(&request("local", Some("local")))
            .unwrap()
            .is_empty());
        assert_eq!(
            providers
                .operation_connections(&request("local", Some("ftp:x")))
                .err()
                .unwrap()
                .code,
            "EFILESYSTEM_ID"
        );
        assert_eq!(
            providers
                .operation_connections(&request("sftp:x", Some("local")))
                .err()
                .unwrap()
                .code,
            "ESSH_DISCONNECTED"
        );
        let frame = serde_json::to_value(OperationConnections::default()).unwrap();
        assert_eq!(frame, serde_json::json!({ "remote": [] }));
    }
}
