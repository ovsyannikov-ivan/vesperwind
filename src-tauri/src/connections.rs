use serde::{Deserialize, Serialize};

// Shared profile identity; protocols add their own connection implementation.
// The existing flat SSH fields and sftp:<id> provider contract stay compatible.
// SFTP-only fields: private_key_path, trusted_fingerprint, save_key_passphrase,
// ssh_config_host. FTP/FTPS-only fields: ftp_tls (FTPS), ftp_data_mode,
// ftp_encoding, tls_trusted_certificate (FTPS), plaintext_acknowledged (FTP).
// Settings normalization guarantees that a profile only carries its own fields.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub auth_type: String,
    pub private_key_path: Option<String>,
    pub initial_path: Option<String>,
    pub trusted_fingerprint: Option<String>,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub save_key_passphrase: bool,
    #[serde(default)]
    pub ssh_config_host: String,
    #[serde(default)]
    pub ftp_tls: String,
    #[serde(default)]
    pub ftp_data_mode: String,
    #[serde(default)]
    pub ftp_encoding: String,
    #[serde(default)]
    pub tls_trusted_certificate: String,
    #[serde(default)]
    pub plaintext_acknowledged: bool,
}
fn default_protocol() -> String {
    "sftp".into()
}

impl ConnectionProfile {
    pub fn is_sftp(&self) -> bool {
        self.protocol == "sftp"
    }
    pub fn permits_password(&self) -> bool {
        match self.protocol.as_str() {
            "sftp" => matches!(self.auth_type.as_str(), "auto" | "password"),
            "ftp" | "ftps" => self.auth_type == "password",
            _ => false,
        }
    }
    /// Key passphrases exist only for SFTP private keys.
    pub fn permits_passphrase(&self) -> bool {
        self.is_sftp() && matches!(self.auth_type.as_str(), "auto" | "privateKey")
    }
}

#[cfg(test)]
pub fn test_profile(auth_type: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: "fixture-profile".into(),
        name: "Fixture".into(),
        protocol: "sftp".into(),
        host: "127.0.0.1".into(),
        port: 22,
        username: "fixture".into(),
        auth_type: auth_type.into(),
        private_key_path: None,
        initial_path: None,
        trusted_fingerprint: None,
        save_password: false,
        save_key_passphrase: false,
        ssh_config_host: String::new(),
        ftp_tls: String::new(),
        ftp_data_mode: String::new(),
        ftp_encoding: String::new(),
        tls_trusted_certificate: String::new(),
        plaintext_acknowledged: false,
    }
}

#[cfg(test)]
pub fn test_ftp_profile(protocol: &str, auth_type: &str) -> ConnectionProfile {
    ConnectionProfile {
        protocol: protocol.into(),
        port: if protocol == "ftps" { 990 } else { 21 },
        auth_type: auth_type.into(),
        ftp_tls: if protocol == "ftps" {
            "implicit".into()
        } else {
            String::new()
        },
        ftp_data_mode: "passive".into(),
        ftp_encoding: "utf-8".into(),
        ..test_profile(auth_type)
    }
}
