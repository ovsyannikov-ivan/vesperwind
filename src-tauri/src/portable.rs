//! One data root shared by the launcher, main WebView, media and Office WebViews.
//! Installed applications keep their existing paths when portable mode is absent.
use std::{fs, path::PathBuf};

pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("VESPERWIND_PORTABLE_DATA_DIR").map(PathBuf::from)
}

pub fn initialize() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let directory = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Executable has no parent directory")?
            .to_owned();
        if data_dir().is_none() && directory.join("portable.json").is_file() {
            std::env::set_var(
                "VESPERWIND_PORTABLE_DATA_DIR",
                directory.join("Vesperwind.data"),
            );
        }
        if let Some(root) = data_dir() {
            validate_root(&root)?;
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", root.join("webview"));
            let runtime = directory.join("vendor/webview2");
            if runtime.join("msedgewebview2.exe").is_file() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime);
            }
        }
    }
    Ok(())
}

fn validate_root(root: &std::path::Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("Portable data directory must be absolute".into());
    }
    fs::create_dir_all(root).map_err(|e| format!("Cannot create portable data directory: {e}"))?;
    let probe = root.join(format!(".write-probe-{}", std::process::id()));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| format!("Portable data directory is not writable: {e}"))?;
    drop(file);
    fs::remove_file(probe).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_root_rejects_relative_paths_and_creates_writable_directory() {
        assert!(validate_root(std::path::Path::new("relative/data")).is_err());
        let root = std::env::temp_dir().join(format!("vesper-portable-{}", uuid::Uuid::new_v4()));
        validate_root(&root).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
}
