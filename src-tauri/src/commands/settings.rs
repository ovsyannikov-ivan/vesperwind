use super::failure;
use crate::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct SettingsPayload {
    settings: Option<Value>,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>, _payload: Value) -> Value {
    response(&state, state.settings.load())
}

#[tauri::command]
pub fn settings_update(state: State<'_, AppState>, payload: SettingsPayload) -> Value {
    response(
        &state,
        state
            .settings
            .save(payload.settings.as_ref().unwrap_or(&Value::Null)),
    )
}

#[tauri::command]
pub fn settings_reset(state: State<'_, AppState>, _payload: Value) -> Value {
    response(&state, state.settings.reset())
}

fn response(state: &AppState, result: Result<Value, crate::error::NativeError>) -> Value {
    match result {
        Ok(settings) => json!({
            "ok": true,
            "settings": settings,
            "storagePath": state.settings.path().to_string_lossy(),
        }),
        Err(error) => failure(error),
    }
}
