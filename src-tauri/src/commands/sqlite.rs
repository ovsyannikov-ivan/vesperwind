use crate::{
    commands::failure, filesystem::availability::require_content_ready, sqlite::Request, AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    session_id: String,
    path: String,
    filesystem_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    session_id: String,
}
#[tauri::command]
pub async fn sqlite_open(
    state: State<'_, AppState>,
    payload: OpenPayload,
) -> Result<Value, String> {
    if payload
        .filesystem_id
        .as_deref()
        .is_some_and(|id| id != "local")
    {
        return Ok(
            json!({"ok":false,"error":{"code":"ENOTSUPPORTED","message":"SQLite editing currently supports local files, mounted disks and shares"}}),
        );
    }
    let real = match require_content_ready(&state.filesystem, Some("local"), &payload.path) {
        Ok(real) => real,
        Err(e) => return Ok(failure(e)),
    };
    let sessions = Arc::clone(&state.sqlite);
    tauri::async_runtime::spawn_blocking(move || match sessions.open(&payload.session_id, &real) {
        Ok(value) => value,
        Err(e) => failure(e),
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn sqlite_request(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    let sessions = Arc::clone(&state.sqlite);
    tauri::async_runtime::spawn_blocking(move || sessions.run(payload))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn sqlite_close(state: State<'_, AppState>, payload: SessionPayload) -> Value {
    state.sqlite.close(&payload.session_id);
    json!({"ok":true})
}
