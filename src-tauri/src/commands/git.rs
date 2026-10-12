use super::failure;
use crate::{
    error::NativeError,
    git::{self, Request},
    AppState,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};

async fn inspect(state: State<'_, AppState>, payload: Request, operation: &'static str) -> Value {
    let filesystem = Arc::clone(&state.filesystem);
    match tauri::async_runtime::spawn_blocking(move || {
        git::operation(&filesystem, operation, payload)
    })
    .await
    {
        Ok(Ok(mut value)) => {
            value["ok"] = json!(true);
            value
        }
        Ok(Err(error)) => failure(error),
        Err(error) => failure(NativeError::new("EGIT", error.to_string())),
    }
}
#[tauri::command]
pub async fn git_detect(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "detect").await)
}
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "status").await)
}
#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "branches").await)
}
#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "log").await)
}
#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "commit").await)
}
#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    Ok(inspect(state, payload, "diff").await)
}
#[tauri::command]
pub async fn git_watch(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: Request,
) -> Result<Value, String> {
    if payload.filesystem_id != "local" {
        return Ok(failure(NativeError::new(
            "EFILESYSTEM_ID",
            "Git is available only for local filesystems",
        )));
    }
    let Some(path) = payload.path else {
        return Ok(failure(NativeError::new(
            "EINVAL",
            "Repository path is required",
        )));
    };
    let filesystem = Arc::clone(&state.filesystem);
    let watches = Arc::clone(&state.git_watches);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || watches.watch(&filesystem, &path, app))
            .await
        {
            Ok(Ok(mut value)) => {
                value["ok"] = json!(true);
                value
            }
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EGIT_WATCH", error.to_string())),
        },
    )
}
#[tauri::command]
pub async fn git_unwatch(state: State<'_, AppState>, payload: Request) -> Result<Value, String> {
    if payload.filesystem_id != "local" {
        return Ok(failure(NativeError::new(
            "EFILESYSTEM_ID",
            "Git is available only for local filesystems",
        )));
    }
    if let Some(path) = payload.path {
        state.git_watches.unwatch(&path);
    }
    Ok(json!({"ok": true}))
}
