use super::{failure, success};
use crate::{
    error::NativeError,
    shell_integration::{
        clipboard::{ClipboardFileRef, ClipboardOperation},
        disk_image, DropRequest, ShellIntegration,
    },
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};

async fn blocking<T: serde::Serialize + Send + 'static>(
    field: &'static str,
    work: impl FnOnce() -> Result<T, NativeError> + Send + 'static,
) -> Value {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(Ok(value)) => success(field, value),
        Ok(Err(error)) => failure(error),
        Err(error) => failure(NativeError::new("ENATIVE", error.to_string())),
    }
}

fn shell(state: &State<'_, AppState>) -> Arc<ShellIntegration> {
    Arc::clone(&state.shell)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWritePayload {
    operation: ClipboardOperation,
    items: Vec<ClipboardFileRef>,
}

#[tauri::command]
pub async fn clipboard_write(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: ClipboardWritePayload,
) -> Result<Value, String> {
    let shell = shell(&state);
    Ok(blocking("clipboard", move || {
        shell.write_clipboard(&app, payload.operation, payload.items)
    })
    .await)
}

#[tauri::command]
pub async fn clipboard_read(state: State<'_, AppState>, app: AppHandle) -> Result<Value, String> {
    let shell = shell(&state);
    Ok(blocking("clipboard", move || shell.read_clipboard(&app)).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardConsumePayload {
    token: Option<String>,
    operation: ClipboardOperation,
}

#[tauri::command]
pub async fn clipboard_consume(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: ClipboardConsumePayload,
) -> Result<Value, String> {
    let shell = shell(&state);
    Ok(blocking("consumed", move || {
        shell
            .consume(&app, payload.token, payload.operation)
            .map(|_| true)
    })
    .await)
}

#[tauri::command]
pub async fn drop_read(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: DropRequest,
) -> Result<Value, String> {
    let shell = shell(&state);
    Ok(blocking("items", move || shell.read_drop(&app, payload)).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragStartPayload {
    items: Vec<ClipboardFileRef>,
}

#[tauri::command]
pub async fn drag_start(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: DragStartPayload,
) -> Result<Value, String> {
    let shell = shell(&state);
    Ok(blocking("started", move || {
        shell.start_drag(&app, payload.items).map(|_| true)
    })
    .await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskImagePayload {
    action: String,
    filesystem_id: Option<String>,
    path: String,
}

#[tauri::command]
pub async fn disk_image_operate(payload: DiskImagePayload) -> Result<Value, String> {
    Ok(blocking("image", move || {
        let provider = payload.filesystem_id.as_deref();
        match payload.action.as_str() {
            "status" => disk_image::status(provider, &payload.path),
            "mount" => disk_image::mount(provider, &payload.path),
            "unmount" => disk_image::unmount(provider, &payload.path),
            _ => Err(NativeError::new("EINVAL", "Unknown disk image action")),
        }
    })
    .await)
}

#[tauri::command]
pub fn shell_capabilities() -> Value {
    json!({ "ok": true, "capabilities": crate::shell_integration::capabilities() })
}
