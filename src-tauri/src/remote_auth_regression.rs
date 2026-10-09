//! Opt-in debug acceptance with a controlled loopback SSH server and synthetic
//! credentials. Never enabled by ordinary startup or a release build.
use crate::{
    connections::ConnectionProfile, credential_store::CredentialKind, ssh_auth::AuthSecrets,
    AppState,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

pub fn fixture_root() -> Option<PathBuf> {
    let root = if std::env::args().nth(1).as_deref() == Some("--remote-auth-regression") {
        PathBuf::from(std::env::args().nth(2)?)
    } else {
        PathBuf::from(std::env::var_os("VESPERWIND_REMOTE_ACCEPTANCE_ROOT")?)
    };
    root.is_absolute().then_some(root)
}

pub fn start(app: &AppHandle) {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--remote-auth-regression") {
        return;
    }
    let Some(root) = args.get(2) else {
        app.exit(2);
        return;
    };
    let phase = args.get(3).cloned().unwrap_or_else(|| "seed".into());
    let root = PathBuf::from(root);
    let app = app.clone();
    std::thread::spawn(move || {
        let result = run(&app, &root, &phase);
        let value = match &result {
            Ok(events) => json!({"ok":true,"events":events}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        let _ = fs::write(
            root.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&value).unwrap(),
        );
        app.exit(if result.is_ok() { 0 } else { 2 });
    });
}
fn run(app: &AppHandle, root: &std::path::Path, phase: &str) -> Result<Vec<&'static str>, String> {
    let input: Value = serde_json::from_slice(
        &fs::read(root.join("fixture.json")).map_err(|_| "Unable to read acceptance fixture")?,
    )
    .map_err(|_| "Invalid acceptance fixture")?;
    let state = app.state::<AppState>();
    let profile = |suffix: &str, mode: &str, saved: bool| -> ConnectionProfile {
        serde_json::from_value(json!({"id":format!("{}-{suffix}",input["id"].as_str().unwrap()),"name":"Remote acceptance fixture","protocol":"sftp",
            "host":"127.0.0.1","port":input["port"],"username":"fixture","authType":mode,
            "privateKeyPath":"","initialPath":"/","trustedFingerprint":input["fingerprint"],
            "savePassword":saved,"saveKeyPassphrase":false,"sshConfigHost":""})).unwrap()
    };
    let mut events = vec![];
    #[cfg(target_os = "windows")]
    {
        if crate::commands::permissions::permissions_capabilities()["supported"] != false {
            return Err("Windows incorrectly advertises macOS permission setup".into());
        }
        let settings = state.settings.load().map_err(|e| e.message)?;
        if settings["permissions"]["setupCompleted"] != false {
            return Err("Fresh Windows permission completion metadata changed".into());
        }
        events.push("windows-permission-setup-unsupported");
        events.push("windows-setup-completed-remains-false");
    }
    let password = profile("password", "password", true);
    let mut encrypted = profile("encrypted", "privateKey", false);
    encrypted.private_key_path = Some(root.join("encrypted-key").to_string_lossy().into_owned());
    encrypted.save_key_passphrase = true;
    let save = |profiles: &[ConnectionProfile]| -> Result<(), String> {
        let mut settings = state.settings.load().map_err(|e| e.message)?;
        settings["connections"] = serde_json::to_value(profiles).unwrap();
        state.settings.save(&settings).map_err(|e| e.message)?;
        Ok(())
    };
    let connect = |p: ConnectionProfile, values: AuthSecrets| {
        state
            .ssh
            .connect_with_auth(app.clone(), p, values)
            .map_err(|e| e.error.code)
    };
    match phase {
        "seed" => {
            save(&[password.clone(), encrypted.clone()])?;
            let mut unknown = password.clone();
            unknown.trusted_fingerprint = None;
            let error = connect(
                unknown,
                AuthSecrets::legacy("password", "vesper-fixture-password".into()),
            )
            .err()
            .ok_or("Unknown host was accepted")?;
            if error != "EHOSTKEY_UNKNOWN" {
                return Err("Unknown host-key result was not preserved".into());
            }
            if state
                .ssh
                .credentials
                .exists(&password, CredentialKind::Password)
                .map_err(|e| e.message)?
            {
                return Err("Unknown host saved a credential".into());
            }
            events.push("unknown-host-blocked-before-auth-and-store");
            let mut changed = password.clone();
            changed.trusted_fingerprint = Some("SHA256:changed-fixture".into());
            if connect(
                changed,
                AuthSecrets::legacy("password", "vesper-fixture-password".into()),
            )
            .err()
            .as_deref()
                != Some("EHOSTKEY_CHANGED")
            {
                return Err("Changed host key was accepted".into());
            }
            events.push("changed-host-blocked-before-auth-and-store");
            let result = connect(
                password.clone(),
                AuthSecrets::legacy("password", "vesper-fixture-password".into()),
            )?;
            if result.credential_warning.is_some() {
                return Err("Password could not be stored in the OS credential store".into());
            }
            if !state
                .ssh
                .credentials
                .exists(&password, CredentialKind::Password)
                .map_err(|e| e.message)?
            {
                return Err("Stored password was not found".into());
            }
            state.ssh.disconnect(&password.id);
            events.push("password-saved-in-system-store");
            let result = connect(
                encrypted.clone(),
                AuthSecrets::legacy("privateKey", "vesper-fixture-passphrase".into()),
            )?;
            if result.credential_warning.is_some() {
                return Err("Passphrase could not be stored securely".into());
            }
            state.ssh.disconnect(&encrypted.id);
            events.push("encrypted-key-passphrase-saved");
        }
        "restart" => {
            // Fresh process, empty frontend/password input and fresh AppState.
            connect(password.clone(), AuthSecrets::default())?;
            events.push("saved-password-after-app-restart");
            let (terminal, _) = state
                .ssh
                .create_terminal(app.clone(), &password.id, 80, 24)
                .map_err(|e| e.code)?;
            state.ssh.terminal_close(&terminal);
            events.push("terminal-uses-saved-password");
            let request = crate::filesystem::operations::OperationRequest {
                filesystem_id: Some(format!("sftp:{}", password.id)),
                ..serde_json::from_value(json!({"action":"copy","sourcePath":"/fixture.txt","targetDirectory":root.to_string_lossy(),"targetFilesystemId":"local"})).unwrap()
            };
            let inputs = state
                .ssh
                .operation_connections(&request)
                .map_err(|e| e.code)?;
            let helper =
                crate::ssh::SshManager::from_operation_connections(inputs).map_err(|e| e.code)?;
            if helper.status(&password.id) != "connected" {
                return Err("Transfer helper did not authenticate".into());
            }
            helper.disconnect(&password.id);
            events.push("transfer-helper-uses-saved-password");
            fs::create_dir_all(root.join("local-transfer"))
                .map_err(|_| "Unable to create transfer fixture")?;
            let transfer = serde_json::from_value(json!({"action":"copy","filesystemId":format!("sftp:{}",password.id),"sourcePath":"/fixture.txt","targetFilesystemId":"local","targetDirectory":root.join("local-transfer").to_string_lossy()})).unwrap();
            crate::filesystem::jobs::execute(
                &state.filesystem,
                &state.ssh,
                transfer,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .map_err(|e| format!("Native transfer failed: {} {}", e.code, e.message))?;
            if fs::read_to_string(root.join("local-transfer/fixture.txt"))
                .map_err(|_| "Transferred file was not found")?
                != "controlled remote fixture\n"
            {
                return Err("Native transfer did not preserve content".into());
            }
            events.push("native-private-pipe-transfer-preserves-content");
            state
                .ssh
                .regression_reconnect(&format!("sftp:{}", password.id))
                .map_err(|e| e.code)?;
            events.push("reconnect-uses-saved-password");
            state.ssh.disconnect(&password.id);
            connect(encrypted.clone(), AuthSecrets::default())?;
            events.push("saved-passphrase-after-app-restart");
            state.ssh.disconnect(&encrypted.id);
            let mut auto = profile("agent", "auto", false);
            auto.private_key_path = None;
            save(&[password.clone(), encrypted.clone(), auto.clone()])?;
            connect(auto.clone(), AuthSecrets::default())?;
            events.push("auto-agent-multiple-identities");
            let (terminal, _) = state
                .ssh
                .create_terminal(app.clone(), &auto.id, 80, 24)
                .map_err(|e| e.code)?;
            state.ssh.terminal_close(&terminal);
            events.push("terminal-uses-agent");
            state.ssh.disconnect(&auto.id);
            auto.auth_type = "agent".into();
            connect(auto.clone(), AuthSecrets::default())?;
            state.ssh.disconnect(&auto.id);
            events.push("explicit-agent");
            let mut config = profile("config", "auto", false);
            config.ssh_config_host = "vesperwind-fixture".into();
            // The fixture config sets IdentitiesOnly and a file key not in agent.
            connect(config.clone(), AuthSecrets::default())?;
            state.ssh.disconnect(&config.id);
            events.push("auto-config-identity-without-password");
            let serialized = fs::read_to_string(state.settings.path())
                .map_err(|_| "Unable to inspect settings")?;
            if serialized.contains("vesper-fixture-password")
                || serialized.contains("vesper-fixture-passphrase")
                || serialized.contains("PRIVATE KEY")
            {
                return Err("A secret leaked into settings".into());
            }
            events.push("settings-contain-metadata-only");
            for (p, kind) in [(&password, "password"), (&encrypted, "keyPassphrase")] {
                let result = tauri::async_runtime::block_on(
                    crate::commands::ssh::connections_forget_credential(
                        app.state(),
                        serde_json::from_value(json!({"profileId":p.id,"kind":kind})).unwrap(),
                    ),
                )?;
                if result["ok"] != true {
                    return Err("Production Forget command failed".into());
                }
            }
            events.push("saved-credentials-forgotten-via-production-command");
        }
        "forgotten" => {
            let error = connect(password.clone(), AuthSecrets::default())
                .err()
                .ok_or("Forgotten password still authenticated")?;
            if error != "EAUTHENTICATION_REQUIRED" {
                return Err("Forgotten password did not request authentication".into());
            }
            events.push("forgotten-password-required-after-restart");
            let error = connect(encrypted.clone(), AuthSecrets::default())
                .err()
                .ok_or("Forgotten passphrase still authenticated")?;
            if error != "EAUTHENTICATION_REQUIRED" {
                return Err("Forgotten passphrase did not request authentication".into());
            }
            events.push("forgotten-passphrase-required-after-restart");
        }
        "reconcile" => {
            for mode in [
                "rename",
                "delete",
                "disable-password",
                "disable-passphrase",
                "endpoint",
                "username",
                "auth",
                "key-path",
            ] {
                let mut old = profile(&format!("reconcile-{mode}"), "auto", true);
                old.save_key_passphrase = true;
                save(std::slice::from_ref(&old))?;
                for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
                    state
                        .ssh
                        .credentials
                        .set(&old, kind, "synthetic-reconcile-secret")
                        .map_err(|e| e.code)?;
                }
                let mut next = old.clone();
                match mode {
                    "rename" => next.name = "Renamed fixture".into(),
                    "disable-password" => next.save_password = false,
                    "disable-passphrase" => next.save_key_passphrase = false,
                    "endpoint" => next.port += 1,
                    "username" => next.username = "other-fixture".into(),
                    "auth" => next.auth_type = "agent".into(),
                    "key-path" => {
                        next.private_key_path =
                            Some(root.join("config-key").to_string_lossy().into_owned())
                    }
                    _ => {}
                }
                let mut settings = state.settings.load().map_err(|e| e.code)?;
                settings["connections"] = if mode == "delete" {
                    json!([])
                } else {
                    json!([next])
                };
                let response =
                    tauri::async_runtime::block_on(crate::commands::settings::settings_update(
                        app.state(),
                        serde_json::from_value(json!({"settings":settings})).unwrap(),
                    ))?;
                if response["ok"] != true {
                    return Err(format!("Production settings update failed: {mode}"));
                }
                let password_exists = state
                    .ssh
                    .credentials
                    .exists(&old, CredentialKind::Password)
                    .map_err(|e| e.code)?;
                let passphrase_exists = state
                    .ssh
                    .credentials
                    .exists(&old, CredentialKind::KeyPassphrase)
                    .map_err(|e| e.code)?;
                let expected = match mode {
                    "rename" => (true, true),
                    "disable-password" => (false, true),
                    "disable-passphrase" | "key-path" => (true, false),
                    _ => (false, false),
                };
                if (password_exists, passphrase_exists) != expected {
                    return Err(format!("Native credential reconciliation failed: {mode}"));
                }
                for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
                    state
                        .ssh
                        .credentials
                        .delete(&old, kind)
                        .map_err(|e| e.code)?;
                }
                events.push(match mode {
                    "rename" => "native-store-rename-preserves-both",
                    "delete" => "native-store-profile-delete-cleans-both",
                    "disable-password" => "native-store-disable-save-password-cleans-password",
                    "disable-passphrase" => {
                        "native-store-disable-save-passphrase-cleans-passphrase"
                    }
                    "endpoint" => "native-store-endpoint-change-cleans-both",
                    "username" => "native-store-username-change-cleans-both",
                    "auth" => "native-store-auth-change-cleans-both",
                    _ => "native-store-key-path-change-cleans-passphrase",
                });
            }
            save(&[])?;
        }
        "cleanup" => {
            state
                .ssh
                .credentials
                .delete(&password, CredentialKind::Password)
                .map_err(|e| e.message)?;
            state
                .ssh
                .credentials
                .delete(&encrypted, CredentialKind::KeyPassphrase)
                .map_err(|e| e.message)?;
            for mode in [
                "rename",
                "delete",
                "disable-password",
                "disable-passphrase",
                "endpoint",
                "username",
                "auth",
                "key-path",
            ] {
                let p = profile(&format!("reconcile-{mode}"), "auto", true);
                for kind in [CredentialKind::Password, CredentialKind::KeyPassphrase] {
                    state.ssh.credentials.delete(&p, kind).map_err(|e| e.code)?;
                    if state.ssh.credentials.exists(&p, kind).map_err(|e| e.code)? {
                        return Err("Synthetic reconciliation entry survived cleanup".into());
                    }
                }
            }
            for (p, kind) in [
                (&password, CredentialKind::Password),
                (&encrypted, CredentialKind::KeyPassphrase),
            ] {
                if state.ssh.credentials.exists(p, kind).map_err(|e| e.code)? {
                    return Err("Synthetic credential survived cleanup".into());
                }
            }
            events.push("synthetic-system-credentials-cleaned-and-absence-verified");
        }
        _ => return Err("Unknown acceptance phase".into()),
    }
    Ok(events)
}
