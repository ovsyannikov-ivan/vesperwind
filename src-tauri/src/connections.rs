use serde::{Deserialize, Serialize};

// Shared profile identity; protocols add their own connection implementation.
// The existing flat SSH fields and sftp:<id> provider contract stay compatible.
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
}
fn default_protocol() -> String {
    "sftp".into()
}

impl ConnectionProfile {
    pub fn permits_password(&self) -> bool {
        matches!(self.auth_type.as_str(), "auto" | "password")
    }
    pub fn permits_passphrase(&self) -> bool {
        matches!(self.auth_type.as_str(), "auto" | "privateKey")
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
    }
}
