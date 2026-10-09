use super::failure;
use crate::{
    connections::ConnectionProfile,
    settings::{normalize_settings, SettingsStore},
    ssh::SshManager,
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[derive(Deserialize)]
pub struct SettingsPayload {
    settings: Option<Value>,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>, _payload: Value) -> Value {
    response(&state, state.settings.load())
}

#[tauri::command]
pub async fn settings_update(
    state: State<'_, AppState>,
    payload: SettingsPayload,
) -> Result<Value, String> {
    let settings = state.settings.clone();
    let ssh = state.ssh.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update(
            &settings,
            &ssh,
            payload.settings.as_ref().unwrap_or(&Value::Null),
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(crate::error::NativeError::new(
            "ESETTINGS",
            "The settings update task failed",
        ))
    });
    Ok(response(&state, result))
}

#[tauri::command]
pub async fn settings_reset(state: State<'_, AppState>, _payload: Value) -> Result<Value, String> {
    let mut value = normalize_settings(&Value::Null);
    // Preserve the SettingsStore reset path, including its tests, while applying
    // credential cleanup to production settings reset just like profile removal.
    let settings = state.settings.clone();
    let ssh = state.ssh.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ssh
            .profile_updates
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = settings.load()?;
        reconcile(&ssh, &previous, &mut value)?;
        settings.reset()
    })
    .await
    .unwrap_or_else(|_| {
        Err(crate::error::NativeError::new(
            "ESETTINGS",
            "The settings reset task failed",
        ))
    });
    Ok(response(&state, result))
}

fn reconcile(
    ssh: &SshManager,
    previous: &Value,
    next: &mut Value,
) -> Result<(), crate::error::NativeError> {
    let decode = |value: &Value| {
        serde_json::from_value::<Vec<ConnectionProfile>>(value["connections"].clone()).map_err(
            |_| crate::error::NativeError::new("ESETTINGS", "Invalid saved connection profiles"),
        )
    };
    let previous_profiles = decode(previous)?;
    let next_profiles = decode(next)?;
    for id in ssh
        .credentials
        .reconcile(&previous_profiles, &next_profiles)?
    {
        ssh.disconnect(&id);
    }
    Ok(())
}
fn update(
    settings: &Arc<SettingsStore>,
    ssh: &Arc<SshManager>,
    value: &Value,
) -> Result<Value, crate::error::NativeError> {
    let _guard = ssh
        .profile_updates
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut next = normalize_settings(value);
    reconcile(ssh, &settings.load()?, &mut next)?;
    settings.save(&next)
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
