use super::failure;
use crate::{
    error::NativeError,
    filesystem::{paths, Filesystem},
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPayload {
    action: String,
    filesystem_id: Option<String>,
    path: String,
}

#[derive(Clone, Copy)]
enum Action {
    Open,
    OpenWith,
    Reveal,
}

fn validate(
    filesystem: &Filesystem,
    payload: &DesktopPayload,
) -> Result<(Action, PathBuf), NativeError> {
    if payload.filesystem_id.as_deref() != Some("local") {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Desktop integration supports local files only",
        ));
    }
    let action = match payload.action.as_str() {
        "open" => Action::Open,
        "open-with" => Action::OpenWith,
        "reveal" => Action::Reveal,
        _ => return Err(NativeError::new("EINVAL", "Unknown desktop action")),
    };
    let logical = paths::resolve_inside_root(filesystem, &payload.path)?;
    fs::symlink_metadata(&logical).map_err(|error| {
        NativeError::from_io(&error, "The requested path is unavailable").with_path(&logical)
    })?;
    let real = paths::verify_existing_inside_root(filesystem, &logical)?;
    let metadata = fs::metadata(&real).map_err(|error| {
        NativeError::from_io(&error, "The requested path is unavailable").with_path(&logical)
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(
            NativeError::new("ENOTSUPPORTED", "Only files and folders can be opened")
                .with_path(&logical),
        );
    }
    if matches!(action, Action::OpenWith) && !metadata.is_file() {
        return Err(NativeError::new("EISDIR", "Open With requires a file").with_path(&logical));
    }
    Ok((
        action,
        if matches!(action, Action::Reveal) {
            logical
        } else {
            real
        },
    ))
}

#[tauri::command]
pub async fn desktop_operate(
    state: State<'_, AppState>,
    payload: DesktopPayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let (action, path) = validate(&filesystem, &payload)?;
            platform_action(action, &path)?;
            Ok::<_, NativeError>(json!({ "ok": true }))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EDESKTOP", error.to_string())),
        },
    )
}

#[cfg(target_os = "macos")]
fn platform_action(action: Action, path: &Path) -> Result<(), NativeError> {
    use std::process::Command;
    match action {
        Action::Open | Action::Reveal => {
            let mut command = Command::new("/usr/bin/open");
            if matches!(action, Action::Reveal) {
                command.arg("-R");
            }
            command.arg("--").arg(path);
            run(command, path)
        }
        Action::OpenWith => {
            // Standard Additions supplies the system application picker. Pass the
            // chosen application as a separate argv value, never through a shell.
            let output = Command::new("/usr/bin/osascript")
                .args([
                    "-e",
                    "POSIX path of (choose application with prompt \"Open With…\")",
                ])
                .output()
                .map_err(|error| io_error(&error, path))?;
            if !output.status.success() {
                let details = String::from_utf8_lossy(&output.stderr);
                if details.contains("(-128)") {
                    return Err(NativeError::new(
                        "ECANCELLED",
                        "Application selection was cancelled",
                    )
                    .with_path(path));
                }
                return Err(
                    NativeError::new("EDESKTOP", "Unable to show the application chooser")
                        .with_path(path)
                        .with_native_error(details.into_owned()),
                );
            }
            let application = String::from_utf8(output.stdout).map_err(|error| {
                NativeError::new("EDESKTOP", "Unable to read the selected application")
                    .with_native_error(error.to_string())
            })?;
            let application = application.trim();
            if application.is_empty() {
                return Err(
                    NativeError::new("EDESKTOP", "No application was selected").with_path(path)
                );
            }
            let mut command = Command::new("/usr/bin/open");
            command.args(["-a", application, "--"]).arg(path);
            run(command, path)
        }
    }
}

#[cfg(target_os = "linux")]
fn platform_action(action: Action, path: &Path) -> Result<(), NativeError> {
    use std::process::Command;
    match action {
        Action::Open => {
            let mut command = Command::new("gio");
            command.arg("open").arg(path);
            run(command, path)
        }
        Action::OpenWith => Err(NativeError::new(
            "ENOTSUPPORTED",
            "An application chooser is unavailable on this desktop",
        )
        .with_path(path)),
        Action::Reveal => {
            // org.freedesktop.FileManager1 is supported by Nautilus and several
            // other managers. If unavailable, open the containing folder via GIO.
            let uri = url::Url::from_file_path(path)
                .map_err(|_| NativeError::new("EINVAL", "Invalid file path"))?;
            let escaped = uri.as_str().replace('\\', "\\\\").replace('\'', "\\'");
            let status = Command::new("gdbus")
                .args([
                    "call",
                    "--session",
                    "--dest",
                    "org.freedesktop.FileManager1",
                    "--object-path",
                    "/org/freedesktop/FileManager1",
                    "--method",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("['{escaped}']"),
                    "",
                ])
                .output();
            if status.is_ok_and(|result| result.status.success()) {
                return Ok(());
            }
            let parent = path.parent().unwrap_or(path);
            let mut command = Command::new("gio");
            command.arg("open").arg(parent);
            run(command, parent)
        }
    }
}

#[cfg(target_os = "windows")]
fn platform_action(action: Action, path: &Path) -> Result<(), NativeError> {
    use std::{os::windows::ffi::OsStrExt, process::Command};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::{
                Shell::{SHOpenWithDialog, ShellExecuteW, OAIF_EXEC, OPENASINFO},
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };
    // canonicalize returns verbatim paths (\\?\C:\...) on Windows. Shell
    // integration expects the ordinary Explorer path spelling.
    let canonical = path.to_string_lossy();
    let shell_path = if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = canonical.strip_prefix(r"\\?\") {
        local.to_owned()
    } else {
        canonical.into_owned()
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&shell_path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    match action {
        Action::Open => {
            let result = unsafe {
                ShellExecuteW(
                    None,
                    w!("open"),
                    PCWSTR(wide.as_ptr()),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            };
            if result.0 as isize <= 32 {
                Err(NativeError::new("EDESKTOP", "Unable to open this item").with_path(path))
            } else {
                Ok(())
            }
        }
        Action::OpenWith => {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| {
                    NativeError::new("EDESKTOP", "Unable to initialize the application chooser")
                        .with_path(path)
                        .with_native_error(error.to_string())
                })?;
            struct ComGuard;
            impl Drop for ComGuard {
                fn drop(&mut self) {
                    unsafe { CoUninitialize() };
                }
            }
            let _com = ComGuard;
            let info = OPENASINFO {
                pcszFile: PCWSTR(wide.as_ptr()),
                pcszClass: PCWSTR::null(),
                oaifInFlags: OAIF_EXEC,
            };
            unsafe { SHOpenWithDialog(None, &info) }.map_err(|error| {
                let cancelled = error.code().0 == 0x800704c7_u32 as i32;
                NativeError::new(
                    if cancelled { "ECANCELLED" } else { "EDESKTOP" },
                    if cancelled {
                        "Application selection was cancelled"
                    } else {
                        "Unable to choose an application"
                    },
                )
                .with_path(path)
                .with_native_error(error.to_string())
            })
        }
        Action::Reveal => {
            let mut command = Command::new("explorer.exe");
            if path.is_file() {
                command.arg(format!("/select,{shell_path}"));
            } else {
                command.arg(&shell_path);
            }
            run(command, path)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_action(_action: Action, path: &Path) -> Result<(), NativeError> {
    Err(NativeError::new(
        "ENOTSUPPORTED",
        "Desktop integration is unavailable on this platform",
    )
    .with_path(path))
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn run(mut command: std::process::Command, path: &Path) -> Result<(), NativeError> {
    let status = command.status().map_err(|error| io_error(&error, path))?;
    if status.success() {
        Ok(())
    } else {
        Err(
            NativeError::new("EDESKTOP", "The system could not open this item")
                .with_path(path)
                .with_native_error(status.to_string()),
        )
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn io_error(error: &std::io::Error, path: &Path) -> NativeError {
    NativeError::from_io(error, "Unable to start the system application")
        .with_path(path)
        .with_native_error(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{validate, Action, DesktopPayload};
    use crate::filesystem::Filesystem;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn validates_local_files_folders_unicode_and_root_boundary() {
        let fixture = std::env::temp_dir().join(format!("vesperwind-desktop-{}", Uuid::new_v4()));
        let root = fixture.join("root");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("Папка with spaces.txt");
        fs::write(&file, b"test").unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let request = |action: &str, path: &std::path::Path, provider: &str| DesktopPayload {
            action: action.into(),
            filesystem_id: Some(provider.into()),
            path: path.to_string_lossy().into_owned(),
        };
        assert!(
            matches!(validate(&filesystem, &request("open", &file, "local")), Ok((Action::Open, path)) if path == fs::canonicalize(&file).unwrap())
        );
        assert!(
            matches!(validate(&filesystem, &request("reveal", &root, "local")), Ok((Action::Reveal, path)) if path == root)
        );
        assert_eq!(
            validate(&filesystem, &request("open-with", &root, "local"))
                .err()
                .unwrap()
                .code,
            "EISDIR"
        );
        assert_eq!(
            validate(
                &filesystem,
                &request("open", &root.join("missing"), "local")
            )
            .err()
            .unwrap()
            .code,
            "ENOENT"
        );
        assert_eq!(
            validate(&filesystem, &request("open", &fixture, "local"))
                .err()
                .unwrap()
                .code,
            "EOUTSIDE_ROOT"
        );
        assert_eq!(
            validate(&filesystem, &request("open", &file, "sftp:demo"))
                .err()
                .unwrap()
                .code,
            "ENOTSUPPORTED"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = fixture.join("outside.txt");
            fs::write(&outside, b"outside").unwrap();
            let link = root.join("outside link.txt");
            symlink(&outside, &link).unwrap();
            assert_eq!(
                validate(&filesystem, &request("open", &link, "local"))
                    .err()
                    .unwrap()
                    .code,
                "EOUTSIDE_ROOT"
            );
        }
        fs::remove_dir_all(fixture).unwrap();
    }
}
