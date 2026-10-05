use crate::{
    office::{CONVERSION_TIMEOUT_MS, MAX_BYTES},
    AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertPayload {
    base64: String,
    format: String,
    operation_id: String,
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelPayload {
    operation_id: String,
}
#[tauri::command]
pub fn document_cancel(state: State<'_, AppState>, payload: CancelPayload) -> Value {
    state.conversion.cancel(&payload.operation_id);
    json!({"ok":true})
}
#[tauri::command]
pub async fn document_convert(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ConvertPayload,
) -> Result<Value, String> {
    if payload.base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Ok(
            json!({"ok":false,"error":{"code":"EFILE_TOO_LARGE","message":"Office conversion limit is 64 MiB"}}),
        );
    }
    let bytes = match STANDARD.decode(&payload.base64) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(
                json!({"ok":false,"error":{"code":"EINVAL","message":"Invalid document bytes"}}),
            )
        }
    };
    let broker = Arc::clone(&state.conversion);
    // Record before dispatch, including cancellation received while queued.
    broker.jobs.register(&payload.operation_id);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            broker.convert(
                app,
                payload.operation_id,
                bytes,
                payload.format,
                payload.timeout_ms.unwrap_or(CONVERSION_TIMEOUT_MS),
            )
        })
        .await
        {
            Ok(Ok(output)) => {
                json!({"ok":true,"base64":STANDARD.encode(output.bytes),"buildId":output.build_id,"initMs":output.init_ms,"conversionMs":output.conversion_ms})
            }
            Ok(Err(error)) => json!({"ok":false,"error":error}),
            Err(error) => {
                json!({"ok":false,"error":{"code":"EWORKER_LOST","message":error.to_string()}})
            }
        },
    )
}
