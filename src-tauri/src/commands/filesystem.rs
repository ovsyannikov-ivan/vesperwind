use super::{failure, success};
use crate::{
    error::NativeError,
    filesystem::{self, availability::require_content_ready, operations::OperationRequest},
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, sync::Arc};
use tauri::State;

const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemRootPayload {
    filesystem_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemPathPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
    content: Option<String>,
}

#[tauri::command]
pub fn filesystem_root(state: State<'_, AppState>, payload: FilesystemRootPayload) -> Value {
    let result = (|| {
        filesystem::Filesystem::require_local(payload.filesystem_id.as_deref())?;
        Ok::<_, NativeError>(json!({
            "ok": true,
            "root": state.filesystem.root_entry()?,
            "homePath": state.filesystem.home().to_string_lossy(),
        }))
    })();
    result.unwrap_or_else(failure)
}

#[tauri::command]
pub fn filesystem_list(state: State<'_, AppState>, payload: FilesystemPathPayload) -> Value {
    let path = payload.path.unwrap_or_default();
    let result = (|| {
        filesystem::Filesystem::require_local(payload.filesystem_id.as_deref())?;
        let entries = state.filesystem.list_directory(&path)?;
        Ok::<_, NativeError>(json!({ "ok": true, "path": path, "entries": entries }))
    })();
    result.unwrap_or_else(failure)
}

#[tauri::command]
pub async fn filesystem_read_text(
    state: State<'_, AppState>,
    payload: FilesystemPathPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    let requested = path.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let metadata = fs::metadata(&real).map_err(|error| text_error(&error, &requested))?;
            validate_text_metadata(&metadata)?;
            let content = fs::read(&real).map_err(|error| text_error(&error, &requested))?;
            Ok::<_, NativeError>(json!({
                "ok": true,
                "content": String::from_utf8_lossy(&content),
                "modifiedAt": metadata.modified().ok().map(filesystem::format_time),
            }))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to read this file")
                    .with_path(path)
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

#[tauri::command]
pub async fn filesystem_write_text(
    state: State<'_, AppState>,
    payload: WriteTextPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    let content = match payload.content {
        Some(content) => content,
        None => return Ok(failure(NativeError::new("EINVAL", "Invalid file contents"))),
    };
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Ok(failure(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 10 MB cannot be opened in the editor",
        )));
    }
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    let requested = path.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            validate_text_metadata(
                &fs::metadata(&real).map_err(|error| text_error(&error, &requested))?,
            )?;
            fs::write(&real, content).map_err(|error| text_error(&error, &requested))?;
            let metadata = fs::metadata(&real).map_err(|error| text_error(&error, &requested))?;
            Ok::<_, NativeError>(json!({
                "ok": true,
                "modifiedAt": metadata.modified().ok().map(filesystem::format_time),
            }))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to save this file")
                    .with_path(path)
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

#[tauri::command]
pub async fn filesystem_operate(
    state: State<'_, AppState>,
    payload: OperationRequest,
) -> Result<Value, String> {
    let filesystem: Arc<filesystem::Filesystem> = Arc::clone(&state.filesystem);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            filesystem::operations::perform(&filesystem, payload)
        })
        .await
        {
            Ok(Ok(result)) => success("result", result),
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EFILE_OPERATION", error.to_string())),
        },
    )
}

fn validate_text_metadata(metadata: &fs::Metadata) -> Result<(), NativeError> {
    if !metadata.is_file() {
        return Err(NativeError::new("EISDIR", "This item is not a text file"));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 10 MB cannot be opened in the editor",
        ));
    }
    Ok(())
}

fn text_error(error: &std::io::Error, path: &str) -> NativeError {
    let mut result =
        NativeError::from_io(error, "Unable to read or save this file").with_path(path);
    result.message = match result.code.as_str() {
        "EACCES" => "Permission denied",
        "ENOENT" => "File no longer exists",
        "EISDIR" => "This item is not a text file",
        _ => "Unable to read or save this file",
    }
    .to_string();
    result
}
