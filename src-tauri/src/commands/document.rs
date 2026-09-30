use crate::error::NativeError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
pub struct ConvertPayload {
    base64: String,
    format: String,
}

struct TemporaryDocumentDirectory(PathBuf);
impl Drop for TemporaryDocumentDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn converter() -> PathBuf {
    if let Some(value) = std::env::var_os("VESPERWIND_LIBREOFFICE") {
        return value.into();
    }
    #[cfg(target_os = "macos")]
    {
        let standard = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
        if standard.exists() {
            standard
        } else {
            PathBuf::from("soffice")
        }
    }
    #[cfg(target_os = "windows")]
    {
        for root in [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        {
            let standard = PathBuf::from(root)
                .join("LibreOffice")
                .join("program")
                .join("soffice.exe");
            if standard.exists() {
                return standard;
            }
        }
        PathBuf::from("soffice")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from("soffice")
    }
}

fn convert(bytes: Vec<u8>, format: &str) -> Result<Vec<u8>, NativeError> {
    if !matches!(format, "doc" | "rtf") {
        return Err(NativeError::new(
            "EINVAL",
            "Only RTF and DOC can be imported",
        ));
    }
    if bytes.len() > MAX_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Document import limit is 32 MB",
        ));
    }
    let path = std::env::temp_dir().join(format!("vesperwind-document-{}", Uuid::new_v4()));
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(&path)
        .map_err(|e| NativeError::from_io(&e, "Unable to prepare document conversion"))?;
    let temporary = TemporaryDocumentDirectory(path);
    let source = temporary.0.join(format!("input.{format}"));
    fs::write(&source, bytes)
        .map_err(|e| NativeError::from_io(&e, "Unable to prepare document conversion"))?;
    let profile = url::Url::from_directory_path(temporary.0.join("profile"))
        .map_err(|_| NativeError::new("ECONVERTER", "Invalid temporary profile path"))?;
    let mut child = Command::new(converter())
        .arg(format!("-env:UserInstallation={profile}"))
        .args([
            "--headless",
            "--convert-to",
            "docx:Office Open XML Text",
            "--outdir",
        ])
        .arg(&temporary.0)
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                NativeError::new(
                    "ECONVERTER_MISSING",
                    "Document import requires a supported local LibreOffice converter.",
                )
            } else {
                NativeError::from_io(&e, "Unable to start document converter")
            }
        })?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| NativeError::from_io(&e, "Unable to wait for document converter"))?
        {
            if !status.success() {
                return Err(NativeError::new(
                    "ECONVERTER",
                    format!("LibreOffice conversion failed: {status}"),
                ));
            }
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(NativeError::new(
                "ECONVERTER_TIMEOUT",
                "Local document conversion timed out",
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    let output = fs::read(temporary.0.join("input.docx"))
        .map_err(|e| NativeError::from_io(&e, "LibreOffice did not produce a DOCX file"))?;
    if output.len() > MAX_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Converted DOCX exceeds 32 MB",
        ));
    }
    Ok(output)
}

#[tauri::command]
pub async fn document_convert(payload: ConvertPayload) -> Value {
    if payload.base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return json!({"ok":false,"error":{"code":"EFILE_TOO_LARGE","message":"Document import limit is 32 MB"}});
    }
    let bytes = match STANDARD.decode(&payload.base64) {
        Ok(bytes) => bytes,
        Err(_) => {
            return json!({"ok":false,"error":{"code":"EINVAL","message":"Invalid document bytes"}})
        }
    };
    match tauri::async_runtime::spawn_blocking(move || convert(bytes, &payload.format)).await {
        Ok(Ok(bytes)) => json!({"ok":true,"base64":STANDARD.encode(bytes)}),
        Ok(Err(error)) => json!({"ok":false,"error":error}),
        Err(error) => json!({"ok":false,"error":{"code":"ECONVERTER","message":error.to_string()}}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_unsupported_formats_without_spawning() {
        assert!(convert(Vec::new(), "docx").is_err());
    }
}
