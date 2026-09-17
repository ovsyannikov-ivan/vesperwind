use crate::error::NativeError;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

const SETTINGS_VERSION: u64 = 4;
const DEFAULT_EDITABLE_FILES: &[&str] = &[
    ".js", ".mjs", ".cjs", ".ts", ".vue", ".json", ".html", ".css", ".scss", ".md", ".txt", ".xml",
    ".yaml", ".yml", ".ini", ".conf", ".sh", ".py", ".php", ".sql", ".env",
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
        "editor": { "editableFiles": DEFAULT_EDITABLE_FILES },
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
            "editableFiles": normalize_string_list(
                value.pointer("/editor/editableFiles"),
                DEFAULT_EDITABLE_FILES,
                300,
                true,
            )
        },
    })
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
    use super::normalize_settings;
    use serde_json::json;

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
}
