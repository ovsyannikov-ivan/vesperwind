use super::{failure, success};
use crate::{error::NativeError, AppState};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPreparePayload {
    filesystem_id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentOperationPayload {
    operation_id: Option<String>,
}

#[tauri::command]
pub async fn content_prepare(
    state: State<'_, AppState>,
    payload: ContentPreparePayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    let content = Arc::clone(&state.content);
    let path = payload.path.unwrap_or_default();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            content.prepare(&filesystem, payload.filesystem_id.as_deref(), &path)
        })
        .await
        {
            Ok(Ok(preparation)) => success("preparation", preparation),
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to prepare this file")
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

#[tauri::command]
pub async fn content_status(
    state: State<'_, AppState>,
    payload: ContentOperationPayload,
) -> Result<Value, String> {
    let operation_id = match payload.operation_id {
        Some(value) if !value.is_empty() => value,
        _ => {
            return Ok(failure(NativeError::new(
                "EINVAL",
                "An operation ID is required",
            )))
        }
    };
    let filesystem = Arc::clone(&state.filesystem);
    let content = Arc::clone(&state.content);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            content.status(&filesystem, &operation_id)
        })
        .await
        {
            Ok(Ok(preparation)) => success("preparation", preparation),
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to inspect content preparation")
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

#[tauri::command]
pub fn content_cancel(state: State<'_, AppState>, payload: ContentOperationPayload) -> Value {
    let cancelled = payload
        .operation_id
        .as_deref()
        .is_some_and(|operation_id| state.content.cancel(operation_id));
    success("cancelled", cancelled)
}
