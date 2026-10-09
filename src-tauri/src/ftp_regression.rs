//! Opt-in debug acceptance for the native FTP/FTPS backend: local FTP and FTPS
//! servers in this process, a synthetic CA (trusted through the debug-only
//! `VESPERWIND_FTP_TEST_CA`), the real system credential store with synthetic
//! `qa-*` profiles, the real filesystem helper process and an SFTP server run
//! by `scripts/ftp-native-smoke.mjs`. Never part of a release build.
use crate::{
    connections::ConnectionProfile,
    credential_store::CredentialKind,
    filesystem::{jobs, operations::OperationRequest},
    ftp::test_server::{tls_config_from_pem, FtpTestServer, ServerOptions, ServerTls},
    ssh_auth::AuthSecrets,
    AppState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

pub fn requested() -> bool {
    std::env::args().nth(1).as_deref() == Some("--ftp-regression")
}

pub fn start(app: &AppHandle) {
    if !requested() {
        return;
    }
    let args: Vec<_> = std::env::args().collect();
    let (Some(root), Some(phase)) = (args.get(2).cloned(), args.get(3).cloned()) else {
        app.exit(2);
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let root = PathBuf::from(root);
        let result = run(&app, &root, &phase);
        let value = match &result {
            Ok(events) => json!({"ok": true, "events": events}),
            Err(error) => json!({"ok": false, "error": error}),
        };
        let _ = fs::write(
            root.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&value).unwrap(),
        );
        app.exit(if result.is_ok() { 0 } else { 2 });
    });
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

struct Servers {
    _all: Vec<FtpTestServer>,
    roots: std::collections::HashMap<&'static str, PathBuf>,
    explicit_log: Arc<crate::ftp::test_server::ServerLog>,
    self_signed_log: Arc<crate::ftp::test_server::ServerLog>,
}

fn servers(root: &Path, fixture: &Value) -> Result<Servers, String> {
    let pem = |key: &str| PathBuf::from(fixture[key].as_str().unwrap_or_default());
    let trusted = tls_config_from_pem(&pem("leaf"), &pem("key")).map_err(|e| e.to_string())?;
    let untrusted =
        tls_config_from_pem(&pem("selfLeaf"), &pem("selfKey")).map_err(|e| e.to_string())?;
    let port = |name: &str| fixture["ports"][name].as_u64().unwrap_or(0) as u16;
    let throttle = fixture["throttle"].as_u64().unwrap_or(4_000_000) as usize;
    let specs: Vec<(&'static str, ServerOptions)> = vec![
        ("plain", ServerOptions::default()),
        (
            "explicit",
            ServerOptions {
                tls: ServerTls::Explicit,
                tls_config: Some(trusted.clone()),
                require_session_reuse: true,
                ..Default::default()
            },
        ),
        (
            "implicit",
            ServerOptions {
                tls: ServerTls::Implicit,
                tls_config: Some(trusted.clone()),
                require_session_reuse: true,
                ..Default::default()
            },
        ),
        (
            "selfsigned",
            ServerOptions {
                tls: ServerTls::Explicit,
                tls_config: Some(untrusted),
                ..Default::default()
            },
        ),
        (
            "reject",
            ServerOptions {
                stor_final_error: Some(451),
                ..Default::default()
            },
        ),
        (
            "slow",
            ServerOptions {
                throttle,
                ..Default::default()
            },
        ),
    ];
    let mut all = vec![];
    let mut roots = std::collections::HashMap::new();
    let (mut explicit_log, mut self_signed_log) = (None, None);
    for (name, options) in specs {
        let directory = root.join(format!("ftp-{name}"));
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let server = FtpTestServer::start_on(port(name), directory.clone(), options)
            .map_err(|e| format!("{name} server: {e}"))?;
        if name == "explicit" {
            explicit_log = Some(Arc::clone(&server.log));
        }
        if name == "selfsigned" {
            self_signed_log = Some(Arc::clone(&server.log));
        }
        roots.insert(name, directory);
        all.push(server);
    }
    Ok(Servers {
        _all: all,
        roots,
        explicit_log: explicit_log.unwrap(),
        self_signed_log: self_signed_log.unwrap(),
    })
}

fn run(app: &AppHandle, root: &Path, phase: &str) -> Result<Vec<&'static str>, String> {
    let fixture: Value = serde_json::from_slice(
        &fs::read(root.join("fixture.json")).map_err(|_| "Unable to read acceptance fixture")?,
    )
    .map_err(|_| "Invalid acceptance fixture")?;
    let id = fixture["id"]
        .as_str()
        .ok_or("Missing fixture id")?
        .to_string();
    let state = app.state::<AppState>();
    let ftp = state.remote.ftp().clone();
    let profile = |suffix: &str, protocol: &str, extra: Value| -> Value {
        let mut value = json!({
            "id": format!("{id}-{suffix}"), "name": format!("FTP acceptance {suffix}"),
            "protocol": protocol, "host": "localhost",
            "port": fixture["ports"][suffix], "username": "fixture", "authType": "password",
            "savePassword": false, "plaintextAcknowledged": true, "ftpTls": "explicit",
        });
        for (key, item) in extra.as_object().unwrap() {
            value[key] = item.clone();
        }
        value
    };
    let sftp = json!({
        "id": format!("{id}-sftp"), "name": "SFTP acceptance", "protocol": "sftp",
        "host": "127.0.0.1", "port": fixture["sftp"]["port"], "username": "fixture",
        "authType": "password", "trustedFingerprint": fixture["sftp"]["fingerprint"],
        "savePassword": false, "saveKeyPassphrase": false, "sshConfigHost": "", "privateKeyPath": "",
        "initialPath": "/",
    });
    let save = |profiles: Vec<Value>| -> Result<(), String> {
        let mut settings = state.settings.load().map_err(|e| e.message)?;
        settings["connections"] = Value::Array(profiles);
        state.settings.save(&settings).map_err(|e| e.message)?;
        Ok(())
    };
    let stored = |suffix: &str| -> Result<ConnectionProfile, String> {
        let settings = state.settings.load().map_err(|e| e.message)?;
        settings["connections"]
            .as_array()
            .and_then(|items| items.iter().find(|p| p["id"] == format!("{id}-{suffix}")))
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .ok_or_else(|| format!("profile {suffix} is not saved"))
    };
    let connect = |suffix: &str, password: &str| {
        ftp.connect(
            Some(app.clone()),
            &format!("{id}-{suffix}"),
            Zeroizing::new(password.into()),
        )
    };
    let transfer = |request: Value, cancelled: &AtomicBool| {
        let request: OperationRequest = serde_json::from_value(request).unwrap();
        let mut progress = 0u64;
        let result = jobs::execute_with_progress(
            &state.filesystem,
            &state.remote,
            request,
            cancelled,
            |bytes| progress = bytes,
        );
        (result, progress)
    };
    let local = root.join("local");
    fs::create_dir_all(&local).map_err(|e| e.to_string())?;
    let mut events = vec![];
    match phase {
        "seed" => {
            let servers = servers(root, &fixture)?;
            let defaults = || {
                vec![
                    profile("plain", "ftp", json!({"plaintextAcknowledged": false})),
                    profile("explicit", "ftps", json!({"savePassword": true})),
                    profile("implicit", "ftps", json!({"ftpTls": "implicit"})),
                    profile("selfsigned", "ftps", json!({})),
                    profile("reject", "ftp", json!({})),
                    profile("slow", "ftp", json!({})),
                    sftp.clone(),
                ]
            };
            save(defaults())?;
            // Plain FTP refuses to connect until the user acknowledged it.
            let failure = connect("plain", "fixture-password")
                .err()
                .ok_or("plain FTP connected")?;
            if failure.error.code != "EFTP_PLAINTEXT_NOT_ACKNOWLEDGED" {
                return Err(format!("plain FTP: {}", failure.error.code));
            }
            events.push("plain-ftp-requires-acknowledgement");
            let mut profiles = defaults();
            profiles[0]["plaintextAcknowledged"] = json!(true);
            save(profiles.clone())?;
            connect("plain", "fixture-password").map_err(|f| format!("plain: {:?}", f.error))?;
            events.push("plain-ftp-connected-after-acknowledgement");
            // Explicit FTPS with session reuse; the typed password is saved
            // in the system credential store only after success.
            let result = connect("explicit", "fixture-password")
                .map_err(|f| format!("explicit: {:?}", f.error))?;
            if result.credential_warning.is_some() {
                return Err("credential store refused the FTPS password".into());
            }
            if !state
                .ssh
                .credentials
                .exists(&stored("explicit")?, CredentialKind::Password)
                .map_err(|e| e.message)?
            {
                return Err("FTPS password was not saved".into());
            }
            let commands = servers.explicit_log.commands.lock().unwrap().clone();
            let at = |prefix: &str| commands.iter().position(|c| c.starts_with(prefix));
            if !(at("AUTH TLS") < at("PBSZ 0") && at("PROT P") < at("USER")) {
                return Err("explicit FTPS command order".into());
            }
            events.push("explicit-ftps-password-saved-after-verified-login");
            connect("implicit", "fixture-password")
                .map_err(|f| format!("implicit: {:?}", f.error))?;
            events.push("implicit-ftps-connected");
            // An untrusted certificate: details, no credentials, then an
            // explicit pin for exactly this certificate.
            let failure = connect("selfsigned", "fixture-password")
                .err()
                .ok_or("untrusted FTPS connected")?;
            let certificate = failure.certificate.ok_or("no certificate details")?;
            if failure.error.code != "ETLS_CERTIFICATE_UNTRUSTED"
                || servers.self_signed_log.sent("PASS")
            {
                return Err(format!("untrusted certificate: {}", failure.error.code));
            }
            events.push("untrusted-certificate-blocked-before-credentials");
            profiles[3]["tlsTrustedCertificate"] = json!(certificate.sha256);
            save(profiles.clone())?;
            connect("selfsigned", "fixture-password")
                .map_err(|f| format!("pinned: {:?}", f.error))?;
            events.push("pinned-certificate-accepted");
            connect("reject", "fixture-password").map_err(|f| format!("reject: {:?}", f.error))?;
            connect("slow", "fixture-password").map_err(|f| format!("slow: {:?}", f.error))?;
            let sftp_profile: crate::connections::ConnectionProfile =
                serde_json::from_value(sftp.clone()).unwrap();
            state
                .ssh
                .connect_with_auth(
                    app.clone(),
                    sftp_profile,
                    AuthSecrets {
                        password: Zeroizing::new(
                            fixture["sftp"]["password"].as_str().unwrap_or("").into(),
                        ),
                        key_passphrase: Zeroizing::new(String::new()),
                    },
                )
                .map_err(|e| format!("sftp: {:?}", e.error))?;
            // Transfers through the real filesystem helper process.
            let size = fixture["size"].as_u64().unwrap_or(24 * 1024 * 1024) as usize;
            let payload: Vec<u8> = (0..size)
                .map(|i| (i as u32).wrapping_mul(2_654_435_761).rotate_right(13) as u8)
                .collect();
            fs::write(local.join("payload.bin"), &payload).map_err(|e| e.to_string())?;
            let expected = digest(&local.join("payload.bin"))?;
            let never = AtomicBool::new(false);
            let local_path = |name: &str| local.join(name).to_string_lossy().into_owned();
            let provider = |suffix: &str, protocol: &str| format!("{protocol}:{id}-{suffix}");
            let (result, progress) = transfer(
                json!({"action":"copy","filesystemId":"local","sourcePath":local_path("payload.bin"),
                "targetFilesystemId":provider("explicit","ftps"),"targetDirectory":"/","timeoutMs": jobs::TRANSFER_TIMEOUT_MS}),
                &never,
            );
            result.map_err(|e| format!("upload: {e:?}"))?;
            if digest(&servers.roots["explicit"].join("payload.bin"))? != expected || progress == 0
            {
                return Err("FTPS upload content or progress".into());
            }
            events.push("helper-upload-local-to-ftps-verified");
            // FTPS -> FTP -> SFTP -> FTPS(implicit) -> local
            for (from, from_path, to) in [
                (
                    provider("explicit", "ftps"),
                    "/payload.bin",
                    provider("plain", "ftp"),
                ),
                (
                    provider("plain", "ftp"),
                    "/payload.bin",
                    provider("sftp", "sftp"),
                ),
                (
                    provider("sftp", "sftp"),
                    "/payload.bin",
                    provider("implicit", "ftps"),
                ),
            ] {
                transfer(json!({"action":"copy","filesystemId":from,"sourcePath":from_path,"targetFilesystemId":to,"targetDirectory":"/",
                    "timeoutMs": jobs::TRANSFER_TIMEOUT_MS}), &never).0.map_err(|e| format!("{from} -> {to}: {e:?}"))?;
            }
            for name in ["plain", "implicit"] {
                if digest(&servers.roots[name].join("payload.bin"))? != expected {
                    return Err(format!("{name} copy differs"));
                }
            }
            if digest(
                &PathBuf::from(fixture["sftp"]["root"].as_str().unwrap_or("")).join("payload.bin"),
            )? != expected
            {
                return Err("SFTP copy differs".into());
            }
            events.push("helper-ftp-to-ftp-ftp-to-sftp-sftp-to-ftps-verified");
            fs::create_dir_all(local.join("back")).map_err(|e| e.to_string())?;
            transfer(json!({"action":"copy","filesystemId":provider("implicit","ftps"),"sourcePath":"/payload.bin",
                "targetFilesystemId":"local","targetDirectory":local_path("back"),"timeoutMs": jobs::TRANSFER_TIMEOUT_MS}), &never)
                .0.map_err(|e| format!("download: {e:?}"))?;
            if digest(&local.join("back/payload.bin"))? != expected {
                return Err("FTPS download differs".into());
            }
            events.push("helper-download-ftps-to-local-verified");
            // A final 451 after every byte: failure, and no partial file.
            let error = transfer(json!({"action":"copy","filesystemId":"local","sourcePath":local_path("payload.bin"),
                "targetFilesystemId":provider("reject","ftp"),"targetDirectory":"/","timeoutMs": jobs::TRANSFER_TIMEOUT_MS}), &never)
                .0.err().ok_or("rejected upload reported success")?;
            if error.code != "EFTP_TRANSFER" || servers.roots["reject"].join("payload.bin").exists()
            {
                return Err(format!("rejected upload: {error:?}"));
            }
            events.push("helper-final-451-fails-and-removes-partial-upload");
            // Cancel one large, throttled download: the helper stops at the
            // next chunk and removes the partial file; a repeat succeeds.
            fs::copy(
                local.join("payload.bin"),
                servers.roots["slow"].join("slow.bin"),
            )
            .map_err(|e| e.to_string())?;
            fs::create_dir_all(local.join("cancel")).map_err(|e| e.to_string())?;
            let cancelled = Arc::new(AtomicBool::new(false));
            {
                let cancelled = Arc::clone(&cancelled);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    cancelled.store(true, std::sync::atomic::Ordering::Release);
                });
            }
            let request = json!({"action":"copy","filesystemId":provider("slow","ftp"),"sourcePath":"/slow.bin",
                "targetFilesystemId":"local","targetDirectory":local_path("cancel"),"timeoutMs": jobs::TRANSFER_TIMEOUT_MS});
            let error = transfer(request.clone(), &cancelled)
                .0
                .err()
                .ok_or("cancelled download succeeded")?;
            if error.code != "ECANCELLED" {
                return Err(format!("cancel: {error:?}"));
            }
            std::thread::sleep(Duration::from_millis(500));
            if local.join("cancel/slow.bin").exists() {
                return Err("cancelled download left a partial file".into());
            }
            events.push("helper-cancel-mid-file-removes-partial-download");
            let started = Instant::now();
            transfer(request, &never)
                .0
                .map_err(|e| format!("repeat after cancel: {e:?}"))?;
            if digest(&local.join("cancel/slow.bin"))? != expected {
                return Err("repeated download differs".into());
            }
            events.push("helper-repeat-after-cancel-verified");
            if fixture["long"] == true
                && started.elapsed() > Duration::from_millis(jobs::IDLE_TIMEOUT_MS)
            {
                events.push("helper-active-transfer-longer-than-idle-timeout-completed");
            }
            // A connected FTP profile is closed by Forget.
            ftp.disconnect(&format!("{id}-explicit"));
        }
        "restart" => {
            let _servers = servers(root, &fixture)?;
            // A fresh process reuses the saved FTPS password.
            connect("explicit", "").map_err(|f| format!("saved password: {:?}", f.error))?;
            events.push("saved-ftps-password-after-restart");
            let profile = stored("explicit")?;
            state
                .ssh
                .credentials
                .delete(&profile, CredentialKind::Password)
                .map_err(|e| e.message)?;
            state.remote.disconnect_profile(&profile);
            if ftp.status(&profile.id) != "disconnected" {
                return Err("Forget did not disconnect".into());
            }
            let failure = connect("explicit", "")
                .err()
                .ok_or("connected after Forget")?;
            if failure.error.code != "EAUTHENTICATION_REQUIRED" {
                return Err(format!("after Forget: {}", failure.error.code));
            }
            events.push("forget-removes-saved-ftps-password");
        }
        "cleanup" => {
            for suffix in [
                "plain",
                "explicit",
                "implicit",
                "selfsigned",
                "reject",
                "slow",
            ] {
                if let Ok(profile) = stored(suffix) {
                    state
                        .ssh
                        .credentials
                        .delete(&profile, CredentialKind::Password)
                        .map_err(|e| e.message)?;
                    if state
                        .ssh
                        .credentials
                        .exists(&profile, CredentialKind::Password)
                        .map_err(|e| e.message)?
                    {
                        return Err(format!("{suffix} credential remained"));
                    }
                }
            }
            events.push("synthetic-system-credentials-cleaned-and-absence-verified");
        }
        _ => return Err("Unknown phase".into()),
    }
    Ok(events)
}
