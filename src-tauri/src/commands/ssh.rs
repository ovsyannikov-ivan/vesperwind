use crate::{credential_store::CredentialKind, ssh_auth::AuthSecrets, ssh_config};
use crate::{ssh::ConnectionProfile, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize)]
pub struct ConnectPayload {
    profile: ConnectionProfile,
    secret: Option<String>,
    secrets: Option<AuthSecrets>,
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
        if let Some(secrets) = payload.secrets {
            manager.connect_with_auth(app, payload.profile, secrets)
        } else {
            manager.connect(app, payload.profile, payload.secret.unwrap_or_default())
        }
    })
    .await;
    Ok(match result {
        Ok(Ok(value)) => {
            json!({"ok":true,"connectionId":value.connection_id,"providerId":value.provider_id,"status":value.status,"root":value.root,"initial":value.initial,"homePath":value.home_path,"credentialWarning":value.credential_warning})
        }
        Ok(Err(error)) => {
            json!({"ok":false,"error":error.error,"hostKey":error.host_key,"auth":error.auth})
        }
        Err(_) => {
            json!({"ok":false,"error":{"code":"ESSH","message":"The SSH connection task failed"}})
        }
    })
}

#[tauri::command]
pub fn ssh_config_hosts() -> Value {
    match ssh_config::load().and_then(|config| ssh_config::hosts(&config)) {
        Ok(hosts) => json!({"ok":true,"hosts":hosts}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}
#[derive(Deserialize)]
pub struct ConfigPayload {
    alias: String,
}
#[tauri::command]
pub fn ssh_config_resolve(payload: ConfigPayload) -> Value {
    match ssh_config::load().and_then(|config| ssh_config::resolve(&config, &payload.alias)) {
        Ok(host) => json!({"ok":true,"host":host}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}
#[tauri::command]
pub fn connections_capabilities(state: State<'_, AppState>) -> Value {
    // `protocols` lists protocols that can connect in this build.
    json!({"ok":true,"capabilities":{"credentialStore":state.ssh.credentials.available(),"sshConfig":true,"auto":true,"agent":true,"protocols":["sftp"]}})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPayload {
    profile_id: String,
    kind: Option<CredentialKind>,
}
fn saved_profile(
    state: &AppState,
    id: &str,
) -> Result<ConnectionProfile, crate::error::NativeError> {
    let settings = state.settings.load()?;
    let value = settings["connections"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .ok_or_else(|| {
            crate::error::NativeError::new("ENOENT", "The connection profile was not found")
        })?;
    serde_json::from_value(value.clone())
        .map_err(|_| crate::error::NativeError::new("EINVAL", "Invalid connection profile"))
}
#[tauri::command]
pub async fn connections_credential_status(
    state: State<'_, AppState>,
    payload: CredentialPayload,
) -> Result<Value, String> {
    let profile = match saved_profile(&state, &payload.profile_id) {
        Ok(profile) => profile,
        Err(error) => return Ok(json!({"ok":false,"error":error})),
    };
    let store = state.ssh.credentials.clone();
    Ok(match tauri::async_runtime::spawn_blocking(move || -> Result<Value, crate::error::NativeError> {
        // Only SFTP profiles have key passphrases; FTP/FTPS never query one.
        let passphrase = profile.is_sftp() && store.exists(&profile, CredentialKind::KeyPassphrase)?;
        Ok(json!({"password":store.exists(&profile, CredentialKind::Password)?,"keyPassphrase":passphrase}))
    }).await {
        Ok(Ok(status)) => json!({"ok":true,"credentials":status}), Ok(Err(error)) => json!({"ok":false,"error":error}),
        Err(_) => json!({"ok":false,"error":{"code":"ECREDENTIAL_STORE","message":"The credential status task failed"}}),
    })
}
#[tauri::command]
pub async fn connections_forget_credential(
    state: State<'_, AppState>,
    payload: CredentialPayload,
) -> Result<Value, String> {
    let profile = match saved_profile(&state, &payload.profile_id) {
        Ok(profile) => profile,
        Err(error) => return Ok(json!({"ok":false,"error":error})),
    };
    let kind = match payload.kind {
        Some(kind) => kind,
        None => {
            return Ok(
                json!({"ok":false,"error":{"code":"EINVAL","message":"Credential kind is required"}}),
            )
        }
    };
    if kind == CredentialKind::KeyPassphrase && !profile.is_sftp() {
        return Ok(
            json!({"ok":false,"error":{"code":"EINVAL","message":"This connection has no key passphrase"}}),
        );
    }
    let remote = state.remote.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let _guard = remote
                .ssh()
                .profile_updates
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            remote.ssh().credentials.delete(&profile, kind)?;
            remote.disconnect_profile(&profile);
            Ok::<_, crate::error::NativeError>(())
        })
        .await
        {
            Ok(Ok(())) => json!({"ok":true}),
            Ok(Err(error)) => json!({"ok":false,"error":error}),
            Err(_) => {
                json!({"ok":false,"error":{"code":"ECREDENTIAL_STORE","message":"The credential removal task failed"}})
            }
        },
    )
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
