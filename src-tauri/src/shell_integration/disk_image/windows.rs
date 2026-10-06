//! Windows ISO mounting through the Storage cmdlets (`Mount-DiskImage`,
//! `Get-DiskImage`, `Dismount-DiskImage`). Mounting an ISO on client Windows
//! does not need elevation, so none is requested; `diskpart` is not used.
use super::{parse_windows_status, powershell_invocation, DiskImageStatus};
use crate::error::NativeError;
use std::{
    io::Read,
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TIMEOUT: Duration = Duration::from_secs(120);

fn run(action: &'static str, image: &Path) -> Result<DiskImageStatus, NativeError> {
    let invocation = powershell_invocation(action, image);
    let mut command = Command::new(&invocation.program);
    command
        .args(&invocation.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for (key, value) in &invocation.env {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|error| {
        NativeError::from_io(&error, "Unable to start Windows PowerShell").with_path(image)
    })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stdout.by_ref().take(1024 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stderr.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NativeError::new(
                    "ETIMEDOUT",
                    "Windows did not finish the disk image operation",
                )
                .with_path(image));
            }
            Err(error) => {
                return Err(NativeError::from_io(
                    &error,
                    "Unable to monitor Windows PowerShell",
                ))
            }
        }
    }
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let text = String::from_utf8_lossy(&stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        NativeError::new(
            "EDISK_IMAGE",
            "Windows PowerShell returned an unexpected result",
        )
        .with_path(image)
        .with_native_error(String::from_utf8_lossy(&stderr).trim().to_string())
    })?;
    parse_windows_status(image, &value)
}

pub fn status(image: &Path) -> Result<DiskImageStatus, NativeError> {
    run("status", image)
}

pub fn mount(image: &Path) -> Result<DiskImageStatus, NativeError> {
    run("mount", image)
}

pub fn unmount(image: &Path, _current: &DiskImageStatus) -> Result<DiskImageStatus, NativeError> {
    run("unmount", image)
}
