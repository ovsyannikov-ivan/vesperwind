use crate::{connections::ConnectionProfile, error::NativeError};
use serde::Serialize;
use ssh2_config::{HostParams, ParseRule, SshConfig};
use std::{
    collections::HashSet,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identities: Vec<String>,
    pub identities_only: bool,
    pub unsupported: Option<String>,
}
pub fn load() -> Result<SshConfig, NativeError> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("VESPERWIND_SSH_CONFIG_FIXTURE") {
        return load_path(Path::new(&path));
    }
    let home = dirs::home_dir().ok_or_else(|| {
        NativeError::new("ESSH_CONFIG", "Unable to locate the user SSH configuration")
    })?;
    load_path(&home.join(".ssh/config"))
}
pub fn load_path(path: &Path) -> Result<SshConfig, NativeError> {
    match File::open(path) {
        Ok(file) => SshConfig::default().parse(&mut BufReader::new(file), ParseRule::ALLOW_UNSUPPORTED_FIELDS)
            .map_err(|_| NativeError::new("ESSH_CONFIG", "Unable to read SSH config: invalid or unsupported configuration. Match blocks and token expansion in config values are not supported.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SshConfig::default()),
        Err(_) => Err(NativeError::new("ESSH_CONFIG", "Unable to read the user SSH configuration")),
    }
}
fn unsupported(params: &HostParams) -> Option<String> {
    if params
        .proxy_jump
        .as_ref()
        .is_some_and(|v| !v.is_empty() && v.iter().any(|s| s != "none"))
        || params
            .unsupported_fields
            .get("proxycommand")
            .is_some_and(|v| v.first().is_some_and(|s| s != "none"))
    {
        return Some("This SSH configuration uses ProxyJump/ProxyCommand, which Vesperwind does not support yet.".into());
    }
    // External commands are never executed, including identity/host commands.
    for key in [
        "localcommand",
        "knownhostscommand",
        "pkcs11provider",
        "securitykeyprovider",
    ] {
        if params
            .unsupported_fields
            .get(key)
            .is_some_and(|v| v.first().is_some_and(|s| s != "none"))
        {
            return Some("This SSH configuration requires an external command or provider that Vesperwind does not support.".into());
        }
    }
    None
}
pub fn expand_identity(
    path: &Path,
    host: &str,
    user: &str,
    port: u16,
) -> Result<PathBuf, NativeError> {
    let home = dirs::home_dir().ok_or_else(|| {
        NativeError::new("ESSH_CONFIG", "Unable to locate the user home directory")
    })?;
    let mut value = String::new();
    let raw = path.to_string_lossy();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            value.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => value.push('%'),
            Some('d') => value.push_str(&home.to_string_lossy()),
            Some('h') => value.push_str(host),
            Some('r') => value.push_str(user),
            Some('p') => value.push_str(&port.to_string()),
            _ => {
                return Err(NativeError::new(
                    "ESSH_CONFIG",
                    "Unsupported token in SSH IdentityFile",
                ))
            }
        }
    }
    if value.contains("${") {
        return Err(NativeError::new(
            "ESSH_CONFIG",
            "Environment variable expansion in SSH IdentityFile is not supported",
        ));
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Ok(home.join(relative));
    }
    if value == "~" {
        return Ok(home);
    }
    if value.starts_with('~') {
        return Err(NativeError::new(
            "ESSH_CONFIG",
            "Other users' home paths in SSH IdentityFile are not supported",
        ));
    }
    Ok(PathBuf::from(value))
}
pub fn resolve(config: &SshConfig, alias: &str) -> Result<ConfigHost, NativeError> {
    let params = config.query(alias);
    let host = params.host_name.clone().unwrap_or_else(|| alias.into());
    let username = params.user.clone().unwrap_or_else(|| {
        std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default()
    });
    let port = params.port.unwrap_or(22);
    if host.contains('%')
        || username.contains('%')
        || host.contains("${")
        || username.contains("${")
    {
        return Err(NativeError::new(
            "ESSH_CONFIG",
            "Token expansion in SSH HostName/User is not supported",
        ));
    }
    let identities_only = match params
        .unsupported_fields
        .get("identitiesonly")
        .and_then(|v| v.first())
        .map(String::as_str)
    {
        None | Some("no") => false,
        Some("yes") => true,
        _ => {
            return Err(NativeError::new(
                "ESSH_CONFIG",
                "Invalid IdentitiesOnly value in SSH config",
            ))
        }
    };
    let identities = params
        .identity_file
        .as_ref()
        .into_iter()
        .flatten()
        .filter(|p| p.as_os_str() != "none")
        .map(|path| {
            expand_identity(path, &host, &username, port).map(|v| v.to_string_lossy().into_owned())
        })
        .collect::<Result<_, _>>()?;
    Ok(ConfigHost {
        alias: alias.into(),
        host,
        port,
        username,
        identities,
        identities_only,
        unsupported: unsupported(&params),
    })
}
pub fn hosts(config: &SshConfig) -> Result<Vec<ConfigHost>, NativeError> {
    let mut seen = HashSet::new();
    let mut result = vec![];
    for host in config.get_hosts() {
        for clause in &host.pattern {
            if clause.negated
                || clause.pattern.contains(['*', '?', '[', ']'])
                || !config
                    .intersecting_hosts(&clause.pattern)
                    .any(|matched| std::ptr::eq(matched, host))
                || !seen.insert(clause.pattern.clone())
            {
                continue;
            }
            // Query applies wildcard and inherited Include scopes; never resolve
            // settings by scanning raw Host lines ourselves.
            result.push(resolve(config, &clause.pattern)?);
        }
    }
    Ok(result)
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ResolvedProfile {
    pub profile: ConnectionProfile,
    pub identities: Vec<PathBuf>,
    pub identities_only: bool,
}
pub fn resolve_profile(profile: &ConnectionProfile) -> Result<ResolvedProfile, NativeError> {
    let config = load();
    // A malformed user config must not break independent explicit saved profiles.
    let params = match config {
        Ok(config) => resolve(
            &config,
            if profile.ssh_config_host.is_empty() {
                &profile.host
            } else {
                &profile.ssh_config_host
            },
        )?,
        Err(error) if !profile.ssh_config_host.is_empty() => return Err(error),
        Err(_) => ConfigHost {
            alias: profile.host.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            identities: vec![],
            identities_only: false,
            unsupported: None,
        },
    };
    if let Some(message) = params.unsupported {
        return Err(NativeError::new("ESSH_CONFIG_UNSUPPORTED", message));
    }
    let mut effective = profile.clone();
    if !profile.ssh_config_host.is_empty() {
        // Changes to the real endpoint require a fresh explicit host-key trust.
        if profile.host != params.host || profile.port != params.port {
            effective.trusted_fingerprint = None;
        }
        effective.host = params.host;
        effective.port = params.port;
        effective.username = params.username;
    }
    if let Some(path) = effective
        .private_key_path
        .as_ref()
        .filter(|path| !path.is_empty())
    {
        effective.private_key_path = Some(
            expand_identity(
                Path::new(path),
                &effective.host,
                &effective.username,
                effective.port,
            )?
            .to_string_lossy()
            .into_owned(),
        );
    }
    Ok(ResolvedProfile {
        profile: effective,
        identities: params.identities.into_iter().map(PathBuf::from).collect(),
        identities_only: params.identities_only,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn parse(data: &str) -> SshConfig {
        SshConfig::default()
            .parse(&mut Cursor::new(data), ParseRule::ALLOW_UNSUPPORTED_FIELDS)
            .unwrap()
    }
    #[test]
    fn concrete_aliases_wildcards_comments_duplicates_and_effective_settings() {
        let config = parse("# fixture\nHost production second\n HostName 192.168.10.31\n User manage\n Port 58080\n IdentityFile ~/.ssh/id_ed25519\n IdentitiesOnly yes\nHost dev\n HostName dev.example.com\n User ivan\nHost production\n User wrong\nHost *\n Port 2222\nHost *.example.com !blocked.example.com\n User wildcard\n");
        let discovered = hosts(&config).unwrap();
        assert_eq!(
            discovered
                .iter()
                .map(|h| h.alias.as_str())
                .collect::<Vec<_>>(),
            ["production", "second", "dev"]
        );
        let production = resolve(&config, "production").unwrap();
        assert_eq!(production.host, "192.168.10.31");
        assert_eq!(production.port, 58080);
        assert_eq!(production.username, "manage");
        assert!(production.identities_only);
        assert_eq!(
            Path::new(&production.identities[0]),
            dirs::home_dir().unwrap().join(".ssh/id_ed25519")
        );
        assert_eq!(resolve(&config, "dev").unwrap().port, 2222);
        assert_eq!(
            resolve(&config, "x.example.com").unwrap().username,
            "wildcard"
        );
        assert_ne!(
            resolve(&config, "blocked.example.com").unwrap().username,
            "wildcard"
        );
    }
    #[test]
    fn include_is_resolved_by_library_and_config_is_not_modified() {
        let root = std::env::temp_dir().join(format!("vesper-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let included = root.join("included.conf");
        std::fs::write(
            &included,
            "Host included\n HostName fixture.invalid\n User fixture\n",
        )
        .unwrap();
        let text = format!("Include {}\nHost *\n Port 2222\n", included.display());
        let path = root.join("config");
        std::fs::write(&path, &text).unwrap();
        let config = load_path(&path).unwrap();
        assert_eq!(hosts(&config).unwrap()[0].alias, "included");
        assert_eq!(resolve(&config, "included").unwrap().port, 2222);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        std::fs::write(&path, "invalid\n").unwrap();
        assert!(load_path(&path).is_err());
        assert!(load_path(&root.join("missing"))
            .unwrap()
            .get_hosts()
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn proxy_requirements_are_not_silently_ignored_and_identity_tokens_are_bounded() {
        for directive in [
            "ProxyJump bastion",
            "ProxyCommand ssh proxy",
            "LocalCommand touch file",
        ] {
            assert!(
                resolve(&parse(&format!("Host fixture\n {directive}\n")), "fixture")
                    .unwrap()
                    .unsupported
                    .is_some()
            );
        }
        assert!(
            resolve(&parse("Host fixture\n ProxyCommand none\n"), "fixture")
                .unwrap()
                .unsupported
                .is_none()
        );
        assert_eq!(
            expand_identity(Path::new("/keys/%h-%r-%p-%%"), "host", "user", 2222).unwrap(),
            PathBuf::from("/keys/host-user-2222-%")
        );
        assert!(expand_identity(Path::new("/keys/%x"), "host", "user", 22).is_err());
        assert!(resolve(&parse("Host fixture\n IdentitiesOnly maybe\n"), "fixture").is_err());
    }
    #[test]
    fn singleton_values_keep_first_occurrence_in_the_same_host_block() {
        let value = resolve(&parse("Host fixture\n HostName first.invalid\n HostName wrong.invalid\n User first\n User wrong\n Port 2222\n Port 3333\n IdentitiesOnly yes\n IdentitiesOnly no\n ProxyCommand none\n ProxyCommand wrong\n"), "fixture").unwrap();
        assert_eq!(value.host, "first.invalid");
        assert_eq!(value.username, "first");
        assert_eq!(value.port, 2222);
        assert!(value.identities_only);
        assert!(value.unsupported.is_none());
    }
    #[test]
    fn include_cycles_return_an_error_instead_of_crashing_the_app() {
        let root =
            std::env::temp_dir().join(format!("vesper-config-cycle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("config");
        std::fs::write(&path, format!("Include {}\n", path.display())).unwrap();
        assert!(load_path(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
