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
    let settings = state.settings.clone();
    let ssh = state.ssh.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || update(&settings, &ssh, &Value::Null))
            .await
            .unwrap_or_else(|_| {
                Err(crate::error::NativeError::new(
                    "ESETTINGS",
                    "The settings reset task failed",
                ))
            });
    Ok(response(&state, result))
}

fn save_reconciled(
    ssh: &SshManager,
    previous: &Value,
    next: &Value,
    commit: impl FnOnce() -> Result<Value, crate::error::NativeError>,
) -> Result<Value, crate::error::NativeError> {
    let decode = |value: &Value| {
        serde_json::from_value::<Vec<ConnectionProfile>>(value["connections"].clone()).map_err(
            |_| crate::error::NativeError::new("ESETTINGS", "Invalid saved connection profiles"),
        )
    };
    let previous_profiles = decode(previous)?;
    let next_profiles = decode(next)?;
    let (saved, disconnected) =
        ssh.credentials
            .reconcile_with_commit(&previous_profiles, &next_profiles, commit)?;
    for id in disconnected {
        ssh.disconnect(&id);
    }
    Ok(saved)
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
    let next = normalize_settings(value);
    save_reconciled(ssh, &settings.load()?, &next, || {
        if value.is_null() {
            settings.reset()
        } else {
            settings.save(&next)
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connections::test_profile,
        credential_store::{CredentialKind, CredentialStore, MemoryBackend},
    };

    #[test]
    fn failed_settings_write_and_reset_preserve_profiles_and_both_secrets() {
        for reset in [false, true] {
            let root = std::env::temp_dir()
                .join(format!("vesper-settings-rollback-{}", uuid::Uuid::new_v4()));
            let backup = root.with_extension("backup");
            let path = root.join("settings.json");
            let settings = Arc::new(SettingsStore::at_path(path.clone()));
            let mut profile = test_profile("auto");
            profile.save_password = true;
            profile.save_key_passphrase = true;
            let previous = settings
                .save(&json!({"connections": [profile.clone()]}))
                .unwrap();
            let mut ssh = SshManager::with_settings(settings.clone());
            Arc::get_mut(&mut ssh).unwrap().credentials =
                CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
            for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
                ssh.credentials
                    .set(&profile, kind, "synthetic-rollback-secret")
                    .unwrap();
            }
            // Fail real filesystem persistence without permissions/root-dependent
            // behavior, while retaining the previous JSON for reopening.
            std::fs::rename(&root, &backup).unwrap();
            std::fs::write(&root, "blocked parent").unwrap();
            let mut next = previous.clone();
            next["connections"][0]["host"] = json!("changed.invalid");
            assert!(update(&settings, &ssh, if reset { &Value::Null } else { &next }).is_err());
            assert_eq!(settings.load().unwrap(), previous);
            for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
                assert_eq!(
                    ssh.credentials
                        .get(&profile, kind)
                        .unwrap()
                        .unwrap()
                        .as_str(),
                    "synthetic-rollback-secret"
                );
            }
            std::fs::remove_file(&root).unwrap();
            std::fs::rename(&backup, &root).unwrap();
            assert_eq!(SettingsStore::at_path(path).load().unwrap(), previous);
            // The same production update path succeeds once storage is writable.
            update(&settings, &ssh, if reset { &Value::Null } else { &next }).unwrap();
            assert!(!ssh
                .credentials
                .exists(&profile, CredentialKind::Password)
                .unwrap());
            assert!(!ssh
                .credentials
                .exists(&profile, CredentialKind::KeyPassphrase)
                .unwrap());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
