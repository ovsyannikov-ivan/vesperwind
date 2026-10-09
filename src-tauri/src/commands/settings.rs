use super::failure;
use crate::{
    connections::ConnectionProfile,
    remote::RemoteProviders,
    settings::{
        is_known_connection_protocol, normalize_settings, reset_changed_connection_trust,
        SettingsStore,
    },
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
    let remote = state.remote.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update(
            &settings,
            &remote,
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
    let remote = state.remote.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || update(&settings, &remote, &Value::Null))
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
    remote: &RemoteProviders,
    previous: &Value,
    next: &Value,
    commit: impl FnOnce() -> Result<Value, crate::error::NativeError>,
) -> Result<Value, crate::error::NativeError> {
    // Preserved profiles of unknown protocols have no credentials or sessions.
    let decode = |value: &Value| {
        let known: Vec<Value> = value["connections"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|profile| is_known_connection_protocol(profile))
            .cloned()
            .collect();
        serde_json::from_value::<Vec<ConnectionProfile>>(Value::Array(known)).map_err(|_| {
            crate::error::NativeError::new("ESETTINGS", "Invalid saved connection profiles")
        })
    };
    let previous_profiles = decode(previous)?;
    let next_profiles = decode(next)?;
    let (saved, disconnected) = remote.ssh().credentials.reconcile_with_commit(
        &previous_profiles,
        &next_profiles,
        commit,
    )?;
    // Sessions belong to the protocol the profile had before this update.
    for id in disconnected {
        if let Some(old) = previous_profiles.iter().find(|profile| profile.id == id) {
            remote.disconnect_profile(old);
        }
    }
    Ok(saved)
}
fn update(
    settings: &Arc<SettingsStore>,
    remote: &RemoteProviders,
    value: &Value,
) -> Result<Value, crate::error::NativeError> {
    let _guard = remote
        .ssh()
        .profile_updates
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let previous = settings.load()?;
    let mut next = normalize_settings(value);
    reset_changed_connection_trust(&previous, &mut next);
    save_reconciled(remote, &previous, &next, || {
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
        ssh::SshManager,
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
            assert!(update(
                &settings,
                &RemoteProviders::new(Arc::clone(&ssh)),
                if reset { &Value::Null } else { &next }
            )
            .is_err());
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
            update(
                &settings,
                &RemoteProviders::new(Arc::clone(&ssh)),
                if reset { &Value::Null } else { &next },
            )
            .unwrap();
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
    #[test]
    fn ftp_profiles_keep_their_fields_and_secrets_through_the_production_update() {
        let root = std::env::temp_dir().join(format!("vesper-ftp-update-{}", uuid::Uuid::new_v4()));
        let backup = root.with_extension("backup");
        let settings = Arc::new(SettingsStore::at_path(root.join("settings.json")));
        let mut ssh = SshManager::with_settings(settings.clone());
        Arc::get_mut(&mut ssh).unwrap().credentials =
            CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
        let remote = RemoteProviders::new(Arc::clone(&ssh));
        let ftps = json!({"id":"nas","name":"NAS","host":"nas.invalid","port":990,"username":"ivan",
            "authType":"password","protocol":"ftps","ftpTls":"implicit","savePassword":true,
            "tlsTrustedCertificate":"ab".repeat(32)});
        let ftp = json!({"id":"router","name":"Router","host":"192.0.2.1","port":21,"username":"admin",
            "authType":"password","protocol":"ftp","savePassword":true,"plaintextAcknowledged":true});
        let sftp = serde_json::to_value(test_profile("auto")).unwrap();
        let saved = update(
            &settings,
            &remote,
            &json!({"connections":[ftps, ftp, sftp]}),
        )
        .unwrap();
        let profiles: Vec<ConnectionProfile> =
            serde_json::from_value(saved["connections"].clone()).unwrap();
        for profile in &profiles[..2] {
            ssh.credentials
                .set(profile, CredentialKind::Password, "synthetic-ftp-secret")
                .unwrap();
        }
        // An unrelated settings change keeps every profile and secret.
        let mut next = saved.clone();
        next["appearance"]["theme"] = json!("dark");
        assert_eq!(
            update(&settings, &remote, &next).unwrap()["connections"],
            saved["connections"]
        );
        assert!(ssh
            .credentials
            .exists(&profiles[0], CredentialKind::Password)
            .unwrap());
        // FTPS -> FTP on a failing write: metadata and the FTPS secret are restored.
        let mut downgrade = saved.clone();
        downgrade["connections"][0]["protocol"] = json!("ftp");
        downgrade["connections"][0]["plaintextAcknowledged"] = json!(true);
        std::fs::rename(&root, &backup).unwrap();
        std::fs::write(&root, "blocked parent").unwrap();
        assert!(update(&settings, &remote, &downgrade).is_err());
        assert_eq!(
            settings.load().unwrap()["connections"],
            saved["connections"]
        );
        assert!(ssh
            .credentials
            .exists(&profiles[0], CredentialKind::Password)
            .unwrap());
        std::fs::remove_file(&root).unwrap();
        std::fs::rename(&backup, &root).unwrap();
        // The same update succeeds once storage is writable: the old secret is
        // gone, FTP never receives it, and plaintext must be confirmed again.
        let result = update(&settings, &remote, &downgrade).unwrap();
        assert_eq!(result["connections"][0]["protocol"], "ftp");
        assert_eq!(result["connections"][0]["plaintextAcknowledged"], false);
        assert!(!ssh
            .credentials
            .exists(&profiles[0], CredentialKind::Password)
            .unwrap());
        let downgraded: ConnectionProfile =
            serde_json::from_value(result["connections"][0].clone()).unwrap();
        assert!(!ssh
            .credentials
            .exists(&downgraded, CredentialKind::Password)
            .unwrap());
        // A host change clears the plaintext acknowledgement and the secret.
        let mut moved = result.clone();
        moved["connections"][1]["host"] = json!("192.0.2.2");
        let result = update(&settings, &remote, &moved).unwrap();
        assert_eq!(result["connections"][1]["plaintextAcknowledged"], false);
        assert!(!ssh
            .credentials
            .exists(&profiles[1], CredentialKind::Password)
            .unwrap());
        // Reset removes the remaining FTP-family profiles.
        assert_eq!(
            update(&settings, &remote, &Value::Null).unwrap()["connections"],
            json!([])
        );
        assert!(!std::fs::read_to_string(root.join("settings.json"))
            .unwrap()
            .contains("synthetic"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn newer_settings_are_never_rewritten_and_unknown_profiles_survive_updates() {
        let root =
            std::env::temp_dir().join(format!("vesper-newer-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let newer =
            r#"{"version":99,"connections":[{"id":"x","protocol":"webdav"}],"future":true}"#;
        std::fs::write(&path, newer).unwrap();
        let settings = Arc::new(SettingsStore::at_path(path.clone()));
        let mut ssh = SshManager::with_settings(settings.clone());
        Arc::get_mut(&mut ssh).unwrap().credentials =
            CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
        let remote = RemoteProviders::new(Arc::clone(&ssh));
        let mut profile = test_profile("password");
        profile.save_password = true;
        ssh.credentials
            .set(&profile, CredentialKind::Password, "synthetic")
            .unwrap();
        assert_eq!(settings.load().unwrap_err().code, "ESETTINGS_NEWER_VERSION");
        for value in [json!({"connections": []}), Value::Null] {
            assert_eq!(
                update(&settings, &remote, &value).unwrap_err().code,
                "ESETTINGS_NEWER_VERSION"
            );
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        assert!(ssh
            .credentials
            .exists(&profile, CredentialKind::Password)
            .unwrap());

        // A preserved profile of an unknown protocol is ignored by credential
        // reconciliation and kept through an unrelated update.
        std::fs::remove_file(&path).unwrap();
        let settings = Arc::new(SettingsStore::at_path(path.clone()));
        let unknown =
            json!({"id":"dav","protocol":"webdav","host":"dav.invalid","savePassword":true});
        let saved = update(
            &settings,
            &remote,
            &json!({"connections":[unknown.clone(), profile]}),
        )
        .unwrap();
        let mut next = saved.clone();
        next["appearance"]["theme"] = json!("dark");
        let saved = update(&settings, &remote, &next).unwrap();
        assert_eq!(saved["connections"][0], unknown);
        std::fs::remove_dir_all(root).unwrap();
    }
}
