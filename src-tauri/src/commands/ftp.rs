//! FTP/FTPS connection commands. Connect takes the id of a **saved** profile
//! and an optional typed password; endpoint, TLS mode, certificate pin and
//! plaintext acknowledgement always come from the saved settings.
use crate::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConnectPayload {
    profile_id: String,
    #[serde(default)]
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConnectionPayload {
    connection_id: String,
}

#[tauri::command]
pub async fn ftp_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: FtpConnectPayload,
) -> Result<Value, String> {
    let ftp = state.remote.ftp().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        ftp.connect(Some(app), &payload.profile_id, payload.password)
    })
    .await;
    Ok(match result {
        Ok(Ok(value)) => {
            let mut response = serde_json::to_value(value).unwrap_or_default();
            response["ok"] = json!(true);
            response
        }
        // Certificate details let a later dialog ask for explicit trust;
        // they contain no secret.
        Ok(Err(failure)) => json!({
            "ok": false,
            "error": failure.error,
            "certificate": failure.certificate,
            "auth": failure.authentication.then(|| json!({"needs": "password"})),
        }),
        Err(_) => {
            json!({"ok":false,"error":{"code":"EFTP","message":"The FTP connection task failed"}})
        }
    })
}

#[tauri::command]
pub fn ftp_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: FtpConnectionPayload,
) -> Value {
    state.remote.ftp().disconnect(&payload.connection_id);
    let _ = app.emit(
        "ftp:status",
        json!({"connectionId": payload.connection_id, "status": "disconnected"}),
    );
    json!({"ok": true})
}

#[tauri::command]
pub fn ftp_status(state: State<'_, AppState>, payload: FtpConnectionPayload) -> Value {
    json!({"ok": true, "status": state.remote.ftp().status(&payload.connection_id)})
}
