use crate::error::NativeError;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const SETTINGS_VERSION: u64 = 7;
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
    })
}

fn normalize_settings(value: &Value) -> Value {
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
    })
}

fn default_formatting() -> Value {
    json!({ "formatOnSave": false, "printWidth": 100, "tabWidth": 2, "useTabs": false,
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

fn normalize_connections(value: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    value.and_then(Value::as_array).into_iter().flatten().take(100).filter_map(|item| {
        let id = item.get("id")?.as_str()?.trim();
        let name = item.get("name")?.as_str()?.trim();
        let host = item.get("host")?.as_str()?.trim();
        let username = item.get("username")?.as_str()?.trim();
        let port = item.get("port")?.as_u64()?;
        if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || name.is_empty() || host.is_empty() || username.is_empty() || !(1..=65535).contains(&port) || !seen.insert(id.to_string()) { return None; }
        let auth_type = if item.get("authType").and_then(Value::as_str) == Some("password") { "password" } else { "privateKey" };
        let trusted = item.get("trustedFingerprint").and_then(Value::as_str).filter(|value| value.starts_with("SHA256:")).unwrap_or("");
        Some(json!({
            "id": id, "name": name, "host": host, "port": port, "username": username,
            "authType": auth_type,
            "privateKeyPath": if auth_type == "privateKey" { item.get("privateKeyPath").and_then(Value::as_str).unwrap_or("").trim() } else { "" },
            "initialPath": item.get("initialPath").and_then(Value::as_str).unwrap_or("").trim(),
            "trustedFingerprint": trusted,
        }))
    }).collect()
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
    use super::{default_settings, normalize_settings, SettingsStore};
    use serde_json::json;

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
    fn editor_settings_persist_across_store_instances_and_reset_to_defaults() {
        let root =
            std::env::temp_dir().join(format!("vesper-editor-settings-{}", uuid::Uuid::new_v4()));
        let path = root.join("settings.json");
        let store = SettingsStore {
            path: path.clone(),
            cached: std::sync::Mutex::new(None),
        };
        store.save(&json!({ "editor": { "theme": "github-light", "formatting": { "formatOnSave": true } }})).unwrap();
        let reopened = SettingsStore {
            path,
            cached: std::sync::Mutex::new(None),
        };
        let loaded = reopened.load().unwrap();
        assert_eq!(loaded["editor"]["theme"], "github-light");
        assert_eq!(loaded["editor"]["formatting"]["formatOnSave"], true);
        assert_eq!(reopened.reset().unwrap(), default_settings());
        std::fs::remove_dir_all(root).unwrap();
    }
}
