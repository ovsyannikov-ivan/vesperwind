use crate::error::NativeError;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const SETTINGS_VERSION: u64 = 9;
const EDITOR_FORMATS_V6: &[&str] = &[
    ".jsx",
    ".tsx",
    ".markdown",
    ".toml",
    ".properties",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
    ".swift",
    ".kt",
    ".kts",
    ".scala",
    ".lua",
    ".pl",
    ".pm",
    ".r",
    ".dart",
    ".gradle",
    "Dockerfile",
    "Makefile",
    ".gitignore",
    ".dockerignore",
    "nginx.conf",
    "httpd.conf",
];
const DEFAULT_EDITABLE_FILES: &[&str] = &[
    ".js",
    ".mjs",
    ".cjs",
    ".jsx",
    ".ts",
    ".tsx",
    ".vue",
    ".json",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".less",
    ".md",
    ".markdown",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".conf",
    ".properties",
    ".sh",
    ".py",
    ".php",
    ".sql",
    ".env",
    ".rs",
    ".go",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
    ".swift",
    ".kt",
    ".kts",
    ".scala",
    ".lua",
    ".pl",
    ".pm",
    ".r",
    ".dart",
    ".gradle",
    "Dockerfile",
    "Makefile",
    ".gitignore",
    ".dockerignore",
    "nginx.conf",
    "httpd.conf",
];

#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    cached: Mutex<Option<Value>>,
}

impl SettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(path: PathBuf) -> Self {
        Self {
            path,
            cached: Mutex::new(None),
        }
    }
    pub fn from_environment() -> Result<Self, NativeError> {
        let path = std::env::var("VESPERWIND_SETTINGS_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_settings_path);
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
        Ok(Self {
            path,
            cached: Mutex::new(None),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Value, NativeError> {
        let mut cached = self
            .cached
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(settings) = cached.as_ref() {
            return Ok(settings.clone());
        }

        let settings = match fs::read_to_string(&self.path) {
            Ok(content) => {
                let stored: Value = serde_json::from_str(&content).map_err(|_| {
                    NativeError::new("ESETTINGS", "The settings file contains invalid JSON")
                })?;
                let normalized = normalize_settings(&stored);
                if stored != normalized {
                    self.persist(&normalized)?;
                }
                normalized
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let defaults = default_settings();
                self.persist(&defaults)?;
                defaults
            }
            Err(error) => {
                return Err(NativeError::from_io(
                    &error,
                    "Unable to read or save settings",
                ))
            }
        };
        *cached = Some(settings.clone());
        Ok(settings)
    }

    pub fn save(&self, value: &Value) -> Result<Value, NativeError> {
        let normalized = normalize_settings(value);
        let mut cached = self
            .cached
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        self.persist(&normalized)?;
        *cached = Some(normalized.clone());
        Ok(normalized)
    }

    pub fn reset(&self) -> Result<Value, NativeError> {
        self.save(&default_settings())
    }

    fn persist(&self, settings: &Value) -> Result<(), NativeError> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| NativeError::new("ESETTINGS", "Invalid settings path"))?;
        fs::create_dir_all(directory).map_err(settings_io_error)?;
        let temporary = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut content = serde_json::to_string_pretty(settings)
            .map_err(|_| NativeError::new("ESETTINGS", "Unable to serialize settings"))?;
        content.push('\n');

        if let Err(error) = fs::write(&temporary, content) {
            let _ = fs::remove_file(&temporary);
            return Err(settings_io_error(error));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(settings_io_error)?;
        }
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(settings_io_error(error));
        }
        Ok(())
    }
}

fn default_settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    return home
        .join("Library")
        .join("Application Support")
        .join("Vesperwind")
        .join("settings.json");

    #[cfg(target_os = "windows")]
    return std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"))
        .join("Vesperwind")
        .join("settings.json");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("vesperwind")
        .join("settings.json");
}

fn default_settings() -> Value {
    json!({
        "version": SETTINGS_VERSION,
        "appearance": { "theme": "system", "locale": "" },
        "filesystem": { "hiddenNameSuffixes": [".localized"] },
        "editor": { "theme": "auto", "formatting": default_formatting(), "editableFiles": DEFAULT_EDITABLE_FILES },
        "connections": [],
        "permissions": {"setupCompleted":false},
    })
}

pub(crate) fn normalize_settings(value: &Value) -> Value {
    let theme = match value.pointer("/appearance/theme").and_then(Value::as_str) {
        Some("dark") => "dark",
        Some("light") => "light",
        _ => "system",
    };
    let locale = match value
        .pointer("/appearance/locale")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "ru-ru" => "ru-RU",
        "en-gb" => "en-GB",
        _ => "",
    };

    json!({
        "version": SETTINGS_VERSION,
        "appearance": { "theme": theme, "locale": locale },
        "filesystem": {
            "hiddenNameSuffixes": normalize_string_list(
                value.pointer("/filesystem/hiddenNameSuffixes"),
                &[".localized"],
                100,
                false,
            )
        },
        "editor": {
            "theme": normalize_editor_theme(value.pointer("/editor/theme")),
            "formatting": normalize_formatting(value.pointer("/editor/formatting")),
            "editableFiles": normalize_editable_files(value)
        },
        "connections": normalize_connections(value.get("connections")),
        "permissions": {"setupCompleted":value.pointer("/permissions/setupCompleted").and_then(Value::as_bool).unwrap_or(false)},
    })
}

fn default_formatting() -> Value {
    json!({ "enabled": true, "formatOnSave": false, "printWidth": 100, "tabWidth": 2, "useTabs": false,
        "semi": true, "singleQuote": false, "bracketSpacing": true, "trailingComma": "all",
        "arrowParens": "always", "endOfLine": "auto" })
}

fn normalize_editor_theme(value: Option<&Value>) -> String {
    let id = value.and_then(Value::as_str).unwrap_or("auto");
    let catalog: Value = serde_json::from_str(include_str!("../../../shared/editorThemes.json"))
        .expect("bundled editor theme catalog is valid JSON");
    if catalog
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["id"] == id))
    {
        id.to_owned()
    } else {
        "auto".to_owned()
    }
}

fn normalize_formatting(value: Option<&Value>) -> Value {
    let mut result = default_formatting();
    for key in [
        "enabled",
        "formatOnSave",
        "useTabs",
        "semi",
        "singleQuote",
        "bracketSpacing",
    ] {
        if let Some(candidate) = value.and_then(|v| v.get(key)).and_then(Value::as_bool) {
            result[key] = json!(candidate);
        }
    }
    for (key, min, max) in [("printWidth", 40, 300), ("tabWidth", 1, 8)] {
        if let Some(candidate) = value.and_then(|v| v.get(key)).and_then(Value::as_u64) {
            if (min..=max).contains(&candidate) {
                result[key] = json!(candidate);
            }
        }
    }
    for (key, allowed) in [
        ("trailingComma", &["all", "es5", "none"][..]),
        ("arrowParens", &["always", "avoid"][..]),
        ("endOfLine", &["lf", "crlf", "cr", "auto"][..]),
    ] {
        if let Some(candidate) = value.and_then(|v| v.get(key)).and_then(Value::as_str) {
            if allowed.contains(&candidate) {
                result[key] = json!(candidate);
            }
        }
    }
    result
}

fn normalize_editable_files(value: &Value) -> Vec<String> {
    let mut files = normalize_string_list(
        value.pointer("/editor/editableFiles"),
        DEFAULT_EDITABLE_FILES,
        300,
        true,
    );
    let version = value.get("version").and_then(Value::as_u64);
    if version.is_some_and(|version| version < 6) {
        let mut seen: HashSet<String> = files.iter().map(|item| item.to_lowercase()).collect();
        for item in EDITOR_FORMATS_V6 {
            if seen.insert(item.to_lowercase()) {
                files.push((*item).to_string());
            }
        }
    }
    let previous_defaults: Vec<_> = DEFAULT_EDITABLE_FILES
        .iter()
        .filter(|item| ![".htm", ".less"].contains(item))
        .collect();
    if files.len() == previous_defaults.len()
        && previous_defaults
            .iter()
            .all(|item| files.iter().any(|file| file.eq_ignore_ascii_case(item)))
    {
        return DEFAULT_EDITABLE_FILES
            .iter()
            .map(|item| (*item).to_string())
            .collect();
    }
    files
}

// Connection profiles. shared/defaultSettings.js implements the same rules;
// test/fixtures/settings/connection-profiles.json is the parity contract.
// Profiles contain metadata only and never secrets.
const CONNECTION_PROTOCOLS: &[&str] = &["sftp", "ftp", "ftps"];
const SFTP_AUTH_TYPES: &[&str] = &["auto", "agent", "password", "privateKey"];
const FTP_AUTH_TYPES: &[&str] = &["password", "anonymous"];
const FTP_TLS_MODES: &[&str] = &["explicit", "implicit"];

/// `String.prototype.trim` semantics, so both backends trim identically.
fn js_trim(value: &str) -> &str {
    let space = |c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    };
    value.trim_matches(space)
}
fn bounded_text(value: Option<&Value>, limit: usize) -> Option<String> {
    let text = js_trim(value?.as_str()?);
    (text.chars().count() <= limit && !text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'))
        .then(|| text.to_string())
}
fn optional_text(value: Option<&Value>, limit: usize) -> String {
    bounded_text(value, limit).unwrap_or_default()
}
fn normalize_port(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let port = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|v| v.fract() == 0.0 && *v >= 0.0)
            .map(|v| v as u64)
    })?;
    (1..=65535).contains(&port).then_some(port)
}
/// SHA-256 of the DER certificate as 64 lowercase hex digits.
pub(crate) fn normalize_certificate_pin(value: Option<&Value>) -> String {
    let pin: String = value
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|c| *c != ':')
        .collect::<String>()
        .to_ascii_lowercase();
    if pin.len() == 64 && pin.chars().all(|c| c.is_ascii_hexdigit()) {
        pin
    } else {
        String::new()
    }
}

fn normalize_connection(item: &Value) -> Option<Value> {
    let item = item.as_object()?;
    let id = js_trim(item.get("id")?.as_str()?);
    // A missing protocol is a legacy SFTP profile; an unknown one is never SFTP.
    let protocol = match item.get("protocol") {
        None | Some(Value::Null) => "sftp",
        Some(value) => value.as_str()?,
    };
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        || !CONNECTION_PROTOCOLS.contains(&protocol)
    {
        return None;
    }
    let name: String = item
        .get("name")
        .and_then(Value::as_str)
        .map(|value| js_trim(value).chars().take(120).collect())
        .unwrap_or_default();
    let host = bounded_text(item.get("host"), 255)?;
    let port = normalize_port(item.get("port"))?;
    let mut username = bounded_text(item.get("username"), 128)?;
    if name.is_empty() || host.is_empty() {
        return None;
    }
    let flag = |key: &str| item.get(key).and_then(Value::as_bool).unwrap_or(false);
    if protocol == "sftp" {
        if username.is_empty() {
            return None;
        }
        let auth_type = item
            .get("authType")
            .and_then(Value::as_str)
            .filter(|v| SFTP_AUTH_TYPES.contains(v))
            .unwrap_or("privateKey");
        let trusted = item
            .get("trustedFingerprint")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() <= 100
                    && value.strip_prefix("SHA256:").is_some_and(|rest| {
                        !rest.is_empty()
                            && rest
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))
                    })
            })
            .unwrap_or("");
        return Some(json!({
            "id": id, "name": name, "host": host, "port": port, "username": username,
            "authType": auth_type,
            "protocol": "sftp",
            "savePassword": (["auto", "password"].contains(&auth_type) && flag("savePassword")),
            "saveKeyPassphrase": (["auto", "privateKey"].contains(&auth_type) && flag("saveKeyPassphrase")),
            "sshConfigHost": optional_text(item.get("sshConfigHost"), 255),
            "privateKeyPath": if ["auto", "privateKey"].contains(&auth_type) { optional_text(item.get("privateKeyPath"), 4096) } else { String::new() },
            "initialPath": optional_text(item.get("initialPath"), 4096),
            "trustedFingerprint": trusted,
        }));
    }
    let auth_type = item
        .get("authType")
        .and_then(Value::as_str)
        .filter(|v| FTP_AUTH_TYPES.contains(v))
        .unwrap_or("password");
    if username.is_empty() && auth_type == "anonymous" {
        username = "anonymous".into();
    }
    if username.is_empty() {
        return None;
    }
    let mut profile = json!({
        "id": id, "name": name, "host": host, "port": port, "username": username,
        "authType": auth_type,
        "protocol": protocol,
        "savePassword": (auth_type == "password" && flag("savePassword")),
        "initialPath": optional_text(item.get("initialPath"), 4096),
        "ftpDataMode": "passive",
        "ftpEncoding": "utf-8",
    });
    if protocol == "ftps" {
        profile["ftpTls"] = json!(item
            .get("ftpTls")
            .and_then(Value::as_str)
            .filter(|v| FTP_TLS_MODES.contains(v))
            .unwrap_or("explicit"));
        profile["tlsTrustedCertificate"] =
            json!(normalize_certificate_pin(item.get("tlsTrustedCertificate")));
    } else {
        profile["plaintextAcknowledged"] = json!(flag("plaintextAcknowledged"));
    }
    Some(profile)
}

fn normalize_connections(value: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(100)
        .filter_map(normalize_connection)
        // The first profile with an id wins, so credential identities stay unique.
        .filter(|profile| seen.insert(profile["id"].as_str().unwrap_or("").to_string()))
        .collect()
}

/// Trust belongs to an endpoint. When a saved FTP/FTPS profile moves to
/// another protocol, host, port or TLS mode, its plaintext acknowledgement
/// and certificate pin are cleared. SFTP host-key trust is unchanged.
pub(crate) fn reset_changed_connection_trust(previous: &Value, next: &mut Value) {
    let before = previous["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let Some(profiles) = next["connections"].as_array_mut() else {
        return;
    };
    for profile in profiles {
        let Some(old) = before.iter().find(|old| old["id"] == profile["id"]) else {
            continue;
        };
        let endpoint_changed = old["protocol"] != profile["protocol"]
            || old["host"] != profile["host"]
            || old["port"] != profile["port"];
        if profile["protocol"] == "ftp" && endpoint_changed {
            profile["plaintextAcknowledged"] = json!(false);
        }
        if profile["protocol"] == "ftps" && (endpoint_changed || old["ftpTls"] != profile["ftpTls"])
        {
            profile["tlsTrustedCertificate"] = json!("");
        }
    }
}

fn normalize_string_list(
    value: Option<&Value>,
    defaults: &[&str],
    limit: usize,
    normalize_extension: bool,
) -> Vec<String> {
    let source: Vec<String> = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| defaults.iter().map(|item| item.to_string()).collect());
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for item in source.into_iter().take(limit) {
        let mut item: String = item.trim().chars().take(128).collect();
        if item.is_empty() || (normalize_extension && (item.contains('/') || item.contains('\\'))) {
            continue;
        }
        if normalize_extension
            && !item.starts_with('.')
            && item
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
            && item == item.to_lowercase()
        {
            item.insert(0, '.');
        }
        if seen.insert(item.to_lowercase()) {
            result.push(item);
        }
    }
    result
}

fn settings_io_error(error: std::io::Error) -> NativeError {
    NativeError::from_io(&error, "Unable to read or save settings")
}

#[cfg(test)]
mod tests {
    use super::{
        default_settings, normalize_connections, normalize_formatting, normalize_settings,
        reset_changed_connection_trust, SettingsStore,
    };
    use serde_json::json;

    #[test]
    fn remote_profiles_migrate_explicit_modes_and_persist_only_metadata() {
        for mode in ["auto", "agent", "password", "privateKey"] {
            let normalized = normalize_settings(&json!({"version":7,"connections":[{
                "id":"stable-id","name":"Fixture","host":"fixture.invalid","port":22,"username":"fixture",
                "authType":mode,"savePassword":true,"saveKeyPassphrase":true,"sshConfigHost":"alias","privateKeyPath":"~/key",
                "secret":"fixture-secret","password":"fixture-password","passphrase":"fixture-passphrase","keyContents":"fixture-key"
            }]}));
            let profile = &normalized["connections"][0];
            assert_eq!(profile["authType"], mode);
            assert_eq!(profile["protocol"], "sftp");
            assert_eq!(
                profile["savePassword"],
                ["auto", "password"].contains(&mode)
            );
            assert_eq!(
                profile["saveKeyPassphrase"],
                ["auto", "privateKey"].contains(&mode)
            );
            assert_eq!(profile["sshConfigHost"], "alias");
            for field in ["secret", "password", "passphrase", "keyContents"] {
                assert!(profile.get(field).is_none());
            }
        }
    }

    #[test]
    fn upgrades_only_untouched_editable_defaults_for_html_alias_and_less() {
        let previous: Vec<_> = super::DEFAULT_EDITABLE_FILES
            .iter()
            .filter(|item| ![".htm", ".less"].contains(item))
            .collect();
        let result =
            normalize_settings(&json!({"version": 7, "editor": {"editableFiles": previous}}));
        assert_eq!(
            result["editor"]["editableFiles"],
            json!(super::DEFAULT_EDITABLE_FILES)
        );
        let custom = normalize_settings(
            &json!({"version": 7, "editor": {"editableFiles": [".js", ".html"]}}),
        );
        assert_eq!(custom["editor"]["editableFiles"], json!([".js", ".html"]));
    }

    // Shared with test/connectionProfiles.test.js; both backends must agree.
    const CONNECTION_FIXTURES: &str =
        include_str!("../../../test/fixtures/settings/connection-profiles.json");

    #[test]
    fn connection_profiles_match_the_shared_javascript_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(CONNECTION_FIXTURES).unwrap();
        for case in fixtures["normalize"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let normalized = normalize_connections(Some(&case["input"]));
            assert_eq!(json!(normalized), case["expected"], "{name}");
            let again = normalize_connections(Some(&case["expected"]));
            assert_eq!(json!(again), case["expected"], "{name} (fixed point)");
        }
        for case in fixtures["trustReset"].as_array().unwrap() {
            let previous = json!({ "connections": case["previous"] });
            let mut next = json!({ "connections": case["next"] });
            reset_changed_connection_trust(&previous, &mut next);
            assert_eq!(next["connections"], case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn settings_v8_sftp_profiles_migrate_to_v9_unchanged() {
        let fixtures: serde_json::Value = serde_json::from_str(CONNECTION_FIXTURES).unwrap();
        let v8 = fixtures["normalize"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "v8 SFTP profiles are unchanged")
            .unwrap();
        let settings = normalize_settings(&json!({"version": 8, "connections": v8["input"]}));
        assert_eq!(settings["version"], 9);
        assert_eq!(settings["connections"], v8["input"]);
    }

    #[test]
    fn ftp_profiles_survive_a_settings_store_round_trip() {
        let fixtures: serde_json::Value = serde_json::from_str(CONNECTION_FIXTURES).unwrap();
        let profiles: Vec<_> = fixtures["normalize"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| {
                let name = case["name"].as_str().unwrap();
                name.contains("round trips") || name.contains("implicit anonymous")
            })
            .flat_map(|case| case["expected"].as_array().unwrap().clone())
            .collect();
        let path = std::env::temp_dir()
            .join(format!("vesper-ftp-settings-{}", uuid::Uuid::new_v4()))
            .join("settings.json");
        let store = SettingsStore::at_path(path.clone());
        store
            .save(&json!({ "connections": profiles, "appearance": {"theme":"dark"} }))
            .unwrap();
        let reopened = SettingsStore::at_path(path.clone()).load().unwrap();
        assert_eq!(reopened["connections"], json!(profiles));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("fixture-password"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn normalizes_settings_like_the_web_backend() {
        let result = normalize_settings(&json!({
            "appearance": { "theme": "dark", "locale": "en-gb" },
            "filesystem": { "hiddenNameSuffixes": [".CACHE", ".cache"] },
            "editor": { "editableFiles": ["js", ".Vue", "bad/path"] }
        }));
        assert_eq!(result["appearance"]["locale"], "en-GB");
        assert_eq!(
            result["filesystem"]["hiddenNameSuffixes"],
            json!([".CACHE"])
        );
        assert_eq!(result["editor"]["editableFiles"], json!([".js", ".Vue"]));
    }

    #[test]
    fn editor_formatting_and_themes_are_validated_without_changing_v6_file_choices() {
        let defaults = default_settings();
        assert_eq!(defaults["editor"]["theme"], "auto");
        let result = normalize_settings(&json!({ "version": 6, "editor": {
            "theme": "one-dark-pro", "editableFiles": [".js"], "formatting": {
                "formatOnSave": true, "printWidth": 301, "tabWidth": 0,
                "semi": "false", "singleQuote": true, "useTabs": true,
                "bracketSpacing": false, "trailingComma": "bad", "arrowParens": "bad", "endOfLine": "bad"
            }
        }}));
        assert_eq!(result["editor"]["theme"], "one-dark-pro");
        assert_eq!(result["editor"]["formatting"]["enabled"], true);
        assert_eq!(result["editor"]["editableFiles"], json!([".js"]));
        for key in [
            "printWidth",
            "tabWidth",
            "semi",
            "trailingComma",
            "arrowParens",
            "endOfLine",
        ] {
            assert_eq!(
                result["editor"]["formatting"][key],
                defaults["editor"]["formatting"][key]
            );
        }
        assert_eq!(result["editor"]["formatting"]["formatOnSave"], true);
        assert_eq!(result["editor"]["formatting"]["singleQuote"], true);
        assert_eq!(result["editor"]["formatting"]["useTabs"], true);
        assert_eq!(result["editor"]["formatting"]["bracketSpacing"], false);
        assert_eq!(
            normalize_settings(&json!({ "editor": { "theme": "../../evil" }}))["editor"]["theme"],
            "auto"
        );
        for (key, value) in [
            ("printWidth", json!(40)),
            ("tabWidth", json!(8)),
            ("trailingComma", json!("es5")),
            ("arrowParens", json!("avoid")),
            ("endOfLine", json!("crlf")),
        ] {
            let mut input = json!({ "editor": { "formatting": {} }});
            input["editor"]["formatting"][key] = value.clone();
            assert_eq!(
                normalize_settings(&input)["editor"]["formatting"][key],
                value
            );
        }
    }

    #[test]
    fn prettier_enable_flag_defaults_to_true_and_retains_options_when_disabled() {
        for input in [json!({}), json!({ "version": 6 }), json!({ "version": 7 })] {
            assert_eq!(
                normalize_settings(&input)["editor"]["formatting"]["enabled"],
                true
            );
        }
        for invalid in [json!(null), json!("false"), json!(0)] {
            assert_eq!(
                normalize_formatting(Some(&json!({ "enabled": invalid })))["enabled"],
                true
            );
        }
        let options =
            json!({ "enabled": false, "formatOnSave": true, "useTabs": true, "tabWidth": 8 });
        let result = normalize_formatting(Some(&options));
        for key in ["enabled", "formatOnSave", "useTabs", "tabWidth"] {
            assert_eq!(result[key], options[key]);
        }
    }

    #[test]
    fn editor_settings_persist_across_store_instances_and_reset_to_defaults() {
        let root =
            std::env::temp_dir().join(format!("vesper-editor-settings-{}", uuid::Uuid::new_v4()));
        let path = root.join("settings.json");
        let store = SettingsStore {
            path: path.clone(),
            cached: std::sync::Mutex::new(None),
        };
        store.save(&json!({ "editor": { "theme": "github-light", "formatting": { "enabled": false, "formatOnSave": true, "useTabs": true, "tabWidth": 8 } }})).unwrap();
        let reopened = SettingsStore {
            path,
            cached: std::sync::Mutex::new(None),
        };
        let loaded = reopened.load().unwrap();
        assert_eq!(loaded["editor"]["theme"], "github-light");
        assert_eq!(loaded["editor"]["formatting"]["formatOnSave"], true);
        assert_eq!(loaded["editor"]["formatting"]["enabled"], false);
        assert_eq!(loaded["editor"]["formatting"]["useTabs"], true);
        assert_eq!(loaded["editor"]["formatting"]["tabWidth"], 8);
        assert_eq!(reopened.reset().unwrap(), default_settings());
        std::fs::remove_dir_all(root).unwrap();
    }
}
