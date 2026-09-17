use super::failure;
use crate::{error::NativeError, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
pub struct TerminalCreatePayload {
    cols: Option<i64>,
    rows: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TerminalInputPayload {
    id: Option<String>,
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TerminalResizePayload {
    id: Option<String>,
    cols: Option<i64>,
    rows: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TerminalClosePayload {
    id: Option<String>,
}

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: TerminalCreatePayload,
) -> Value {
    let columns = clamp(payload.cols, 2, 500, 80);
    let rows = clamp(payload.rows, 1, 300, 24);
    match state
        .terminal
        .create(app, state.filesystem.root(), columns, rows)
    {
        Ok((id, reused)) => json!({ "ok": true, "id": id, "reused": reused }),
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub fn terminal_input(state: State<'_, AppState>, payload: TerminalInputPayload) -> Value {
    if let (Some(id), Some(data)) = (payload.id.as_deref(), payload.data.as_deref()) {
        state.terminal.write(id, data);
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, payload: TerminalResizePayload) -> Value {
    if let Some(id) = payload.id.as_deref() {
        state.terminal.resize(
            id,
            clamp(payload.cols, 2, 500, 80),
            clamp(payload.rows, 1, 300, 24),
        );
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, payload: TerminalClosePayload) -> Value {
    state.terminal.close(payload.id.as_deref());
    json!({ "ok": true })
}

fn clamp(value: Option<i64>, minimum: i64, maximum: i64, fallback: i64) -> u16 {
    value
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
        .try_into()
        .unwrap_or(fallback as u16)
}

#[allow(dead_code)]
fn _terminal_error(message: impl Into<String>) -> NativeError {
    NativeError::new("ETERMINAL", message)
}
