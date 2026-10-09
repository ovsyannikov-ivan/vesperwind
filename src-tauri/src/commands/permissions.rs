use super::failure;
use crate::{error::NativeError, permissions};
use serde::Deserialize;
use serde_json::{json, Value};

#[tauri::command]
pub fn permissions_capabilities() -> Value {
    json!({"ok":true,"supported":cfg!(target_os = "macos")})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    request_id: String,
    kind: Option<String>,
    path: Option<String>,
    host: Option<String>,
}
async fn run(payload: Payload, folder: bool) -> Result<Value, String> {
    let flag = match permissions::register(&payload.request_id) {
        Ok(flag) => flag,
        Err(error) => return Ok(failure(error)),
    };
    let id = payload.request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if folder {
            permissions::prepare_folder(payload.path.as_deref().unwrap_or(""), &flag)
        } else {
            permissions::request(
                payload.kind.as_deref().unwrap_or(""),
                payload.host.as_deref(),
                &flag,
            )
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(NativeError::new(
            "EPERMISSION",
            "Permission preparation failed",
        ))
    });
    permissions::finish(&id);
    Ok(match result {
        Ok(()) => json!({"ok":true}),
        Err(error) => failure(error),
    })
}
#[tauri::command]
pub async fn permissions_request(payload: Payload) -> Result<Value, String> {
    run(payload, false).await
}
#[tauri::command]
pub async fn permissions_prepare_folder(payload: Payload) -> Result<Value, String> {
    run(payload, true).await
}
#[tauri::command]
pub fn permissions_cancel(payload: Payload) -> Value {
    permissions::cancel(&payload.request_id);
    json!({"ok":true})
}
