use crate::{ssh::ConnectionProfile, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct ConnectPayload {
    profile: ConnectionProfile,
    secret: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPayload {
    connection_id: String,
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ConnectPayload,
) -> Result<Value, String> {
    let manager = state.ssh.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.connect(
            app.clone(),
            payload.profile,
            payload.secret.unwrap_or_default(),
        )
    })
    .await;
    Ok(match result {
        Ok(Ok(value)) => {
            json!({"ok":true,"connectionId":value.connection_id,"providerId":value.provider_id,"status":value.status,"root":value.root,"initial":value.initial,"homePath":value.home_path})
        }
        Ok(Err(error)) => json!({"ok":false,"error":error.error,"hostKey":error.host_key}),
        Err(error) => json!({"ok":false,"error":{"code":"ESSH","message":error.to_string()}}),
    })
}

#[tauri::command]
pub fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ConnectionPayload,
) -> Value {
    state.ssh.disconnect(&payload.connection_id);
    let _ = app.emit(
        "ssh:status",
        json!({"connectionId":payload.connection_id,"status":"disconnected"}),
    );
    json!({"ok":true})
}

#[tauri::command]
pub fn ssh_status(state: State<'_, AppState>, payload: ConnectionPayload) -> Value {
    json!({"ok":true,"status":state.ssh.status(&payload.connection_id)})
}
