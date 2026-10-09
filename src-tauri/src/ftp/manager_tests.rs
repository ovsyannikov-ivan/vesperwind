//! FtpManager against real local FTP/FTPS servers (see `test_server`), with
//! synthetic credentials, a synthetic CA and in-memory credential storage.
use super::{
    library_contract_tests::temp_root,
    pool::FtpConnection,
    test_certs::{self_signed, TestCa},
    test_server::{FtpTestServer, ListFormat, ServerOptions, ServerTls},
    FtpManager,
};
use crate::{
    connections::ConnectionProfile,
    credential_store::{CredentialKind, CredentialStore, MemoryBackend},
    error::NativeError,
    filesystem::{
        operations::{OperationRequest, OperationResult},
        remote_ops::{self, RemoteEndpoint, RemoteSessions},
        Filesystem,
    },
    settings::SettingsStore,
};
use serde_json::json;
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc, time::Duration};
use zeroize::Zeroizing;

struct Harness {
    manager: Arc<FtpManager>,
    store: Arc<CredentialStore>,
    settings: Arc<SettingsStore>,
    profiles: Vec<serde_json::Value>,
    ca: Option<TestCa>,
}

fn profile(id: &str, protocol: &str, port: u16, extra: serde_json::Value) -> serde_json::Value {
    let mut value = json!({
        "id": id, "name": id, "host": "localhost", "port": port, "username": "fixture",
        "authType": "password", "protocol": protocol, "savePassword": false,
        "plaintextAcknowledged": true, "ftpTls": "explicit",
    });
    for (key, item) in extra.as_object().unwrap() {
        value[key] = item.clone();
    }
    value
}

impl Harness {
    fn new(ca: Option<TestCa>) -> Self {
        let settings = Arc::new(SettingsStore::at_path(
            temp_root("settings").join("settings.json"),
        ));
        let store = CredentialStore::with_backend(Arc::new(MemoryBackend::default()));
        let roots = ca.iter().map(|ca| ca.der.clone()).collect();
        Self {
            manager: FtpManager::with_roots(Arc::clone(&store), Some(Arc::clone(&settings)), roots),
            store,
            settings,
            profiles: vec![],
            ca,
        }
    }
    fn save(&mut self, profile: serde_json::Value) -> ConnectionProfile {
        let id = profile["id"].as_str().unwrap().to_string();
        self.profiles.retain(|p| p["id"] != id);
        self.profiles.push(profile);
        let saved = self
            .settings
            .save(&json!({ "connections": self.profiles }))
            .unwrap();
        let stored = saved["connections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()
            .clone();
        serde_json::from_value(stored).unwrap()
    }
    fn connect(
        &self,
        id: &str,
        password: &str,
    ) -> Result<super::ConnectResult, super::connection::ConnectFailure> {
        self.manager
            .connect(None, id, Zeroizing::new(password.to_string()))
    }
    fn tls_server(&self, tls: ServerTls, options: ServerOptions) -> FtpTestServer {
        let leaf = self
            .ca
            .as_ref()
            .unwrap()
            .leaf(&["localhost", "127.0.0.1"], false);
        server(ServerOptions {
            tls,
            tls_config: Some(super::test_server::tls_config(leaf.chain, leaf.key).unwrap()),
            ..options
        })
    }
}

fn server(options: ServerOptions) -> FtpTestServer {
    FtpTestServer::start(temp_root("server"), options).unwrap()
}

fn sha256(path: &std::path::Path) -> String {
    super::tls::fingerprint(&fs::read(path).unwrap())
}

#[test]
fn plain_ftp_needs_a_saved_profile_and_an_acknowledgement() {
    let mut harness = Harness::new(None);
    let server = server(Default::default());
    assert_eq!(
        harness.connect("missing", "x").unwrap_err().error.code,
        "ENOENT"
    );
    harness.save(profile(
        "plain",
        "ftp",
        server.addr.port(),
        json!({"plaintextAcknowledged": false}),
    ));
    let failure = harness.connect("plain", "fixture-password").unwrap_err();
    assert_eq!(failure.error.code, "EFTP_PLAINTEXT_NOT_ACKNOWLEDGED");
    assert!(server.log.commands.lock().unwrap().is_empty());
    harness.save(profile("plain", "ftp", server.addr.port(), json!({})));
    let connected = harness.connect("plain", "fixture-password").unwrap();
    assert_eq!(connected.provider_id, "ftp:plain");
    assert_eq!(connected.initial.path, "/");
    assert_eq!(harness.manager.status("plain"), "connected");
    // The ftps scheme never reaches an ftp profile.
    assert_eq!(
        harness.manager.get("ftps:plain").err().unwrap().code,
        "EFILESYSTEM_ID"
    );
    harness.manager.disconnect("plain");
    assert_eq!(harness.manager.status("plain"), "disconnected");
    assert!(server.wait_for_closed_controls(Duration::from_secs(5)));
}

#[test]
fn passwords_are_saved_only_after_success_and_never_cross_protocols() {
    let mut harness = Harness::new(None);
    let server = server(Default::default());
    let saved = harness.save(profile(
        "p",
        "ftp",
        server.addr.port(),
        json!({"savePassword": true}),
    ));
    // A wrong password is rejected and never stored.
    let failure = harness.connect("p", "wrong").unwrap_err();
    assert_eq!(failure.error.code, "EAUTHENTICATION_REQUIRED");
    assert!(failure.authentication);
    assert!(!harness
        .store
        .exists(&saved, CredentialKind::Password)
        .unwrap());
    // Nothing typed and nothing saved: the password is required.
    assert_eq!(
        harness.connect("p", "").unwrap_err().error.code,
        "EAUTHENTICATION_REQUIRED"
    );
    harness.connect("p", "fixture-password").unwrap();
    assert_eq!(
        harness
            .store
            .get(&saved, CredentialKind::Password)
            .unwrap()
            .unwrap()
            .as_str(),
        "fixture-password"
    );
    harness.manager.disconnect("p");
    // The saved password is reused for this exact profile.
    harness.connect("p", "").unwrap();
    // A password saved for FTPS under the same id is never used for FTP.
    let mut ftps = saved.clone();
    ftps.protocol = "ftps".into();
    harness
        .store
        .set(&ftps, CredentialKind::Password, "fixture-password")
        .unwrap();
    harness
        .store
        .delete(&saved, CredentialKind::Password)
        .unwrap();
    harness.manager.disconnect("p");
    assert_eq!(
        harness.connect("p", "").unwrap_err().error.code,
        "EAUTHENTICATION_REQUIRED"
    );
    // Unchecked save flag: the typed password works but is not stored.
    let unsaved = harness.save(profile("q", "ftp", server.addr.port(), json!({})));
    harness.connect("q", "fixture-password").unwrap();
    assert!(!harness
        .store
        .exists(&unsaved, CredentialKind::Password)
        .unwrap());
}

#[test]
fn anonymous_login_sends_no_user_password() {
    let mut harness = Harness::new(None);
    let server = server(Default::default());
    harness.save(profile(
        "anon",
        "ftp",
        server.addr.port(),
        json!({"authType": "anonymous", "username": ""}),
    ));
    harness.connect("anon", "ignored").unwrap();
    let commands = server.log.commands.lock().unwrap().clone();
    assert!(commands.iter().any(|c| c == "USER anonymous"));
    assert!(commands.iter().any(|c| c == "PASS anonymous@"));
}

#[test]
fn explicit_and_implicit_ftps_protect_everything_and_reuse_tls_sessions() {
    for (tls, mode) in [
        (ServerTls::Explicit, "explicit"),
        (ServerTls::Implicit, "implicit"),
    ] {
        let mut harness = Harness::new(Some(TestCa::new()));
        let server = harness.tls_server(
            tls,
            ServerOptions {
                require_session_reuse: true,
                ..Default::default()
            },
        );
        harness.save(profile(
            "s",
            "ftps",
            server.addr.port(),
            json!({"ftpTls": mode}),
        ));
        let connected = harness.connect("s", "fixture-password").unwrap();
        assert_eq!(connected.provider_id, "ftps:s");
        let connection = harness.manager.get("ftps:s").unwrap();
        fs::write(server.root.join("Отчёт.txt"), "текст").unwrap();
        let entries = connection.list("/").unwrap();
        assert!(entries
            .iter()
            .any(|e| e.name == "Отчёт.txt" && e.size == Some(10)));
        assert_eq!(
            connection.read_text("/Отчёт.txt", None, true).unwrap().0,
            "текст"
        );
        let commands = server.log.commands.lock().unwrap().clone();
        let index = |prefix: &str| commands.iter().position(|c| c.starts_with(prefix)).unwrap();
        assert!(index("PBSZ 0") < index("USER") && index("PROT P") < index("USER"));
        if tls == ServerTls::Explicit {
            assert!(index("AUTH TLS") < index("PBSZ 0"));
        }
        let resumed = server.log.data_tls_resumed.lock().unwrap().clone();
        assert!(!resumed.is_empty() && resumed.iter().all(|r| *r));
    }
}

#[test]
fn certificate_failures_return_details_and_never_send_credentials() {
    let ca = TestCa::new();
    let mut harness = Harness::new(Some(TestCa::new()));
    let cases = [
        (
            "untrusted",
            self_signed(&["localhost"]),
            "ETLS_CERTIFICATE_UNTRUSTED",
        ),
        (
            "hostname",
            harness.ca.as_ref().unwrap().leaf(&["other.invalid"], false),
            "ETLS_CERTIFICATE_HOSTNAME",
        ),
        (
            "expired",
            harness.ca.as_ref().unwrap().leaf(&["localhost"], true),
            "ETLS_CERTIFICATE_EXPIRED",
        ),
        (
            "unknown CA",
            ca.leaf(&["localhost"], false),
            "ETLS_CERTIFICATE_UNTRUSTED",
        ),
    ];
    for (label, leaf, code) in cases {
        let fingerprint = super::tls::fingerprint(&leaf.chain[0]);
        let server = server(ServerOptions {
            tls: ServerTls::Explicit,
            tls_config: Some(super::test_server::tls_config(leaf.chain, leaf.key).unwrap()),
            ..Default::default()
        });
        harness.save(profile("c", "ftps", server.addr.port(), json!({})));
        let failure = harness.connect("c", "fixture-password").unwrap_err();
        assert_eq!(failure.error.code, code, "{label}");
        let certificate = failure.certificate.expect(label);
        assert_eq!(certificate.sha256, fingerprint, "{label}");
        assert_eq!(
            certificate.endpoint,
            format!("localhost:{}", server.addr.port())
        );
        assert!(
            !server.log.sent("USER") && !server.log.sent("PASS"),
            "{label}"
        );
        if label == "untrusted" {
            // Explicitly pinning exactly this certificate allows the connection.
            harness.save(profile(
                "c",
                "ftps",
                server.addr.port(),
                json!({"tlsTrustedCertificate": fingerprint}),
            ));
            harness.connect("c", "fixture-password").unwrap();
            harness.manager.disconnect("c");
        }
    }
    // A pin of another certificate blocks even a certificate the system trusts.
    let server = harness.tls_server(ServerTls::Explicit, Default::default());
    harness.save(profile(
        "c",
        "ftps",
        server.addr.port(),
        json!({"tlsTrustedCertificate": "ab".repeat(32)}),
    ));
    let failure = harness.connect("c", "fixture-password").unwrap_err();
    assert_eq!(failure.error.code, "ETLS_CERTIFICATE_CHANGED");
    assert_eq!(
        failure.certificate.unwrap().pinned_sha256.as_deref(),
        Some("ab".repeat(32).as_str())
    );
    assert!(!server.log.sent("PASS"));
}

#[test]
fn refused_auth_tls_or_prot_p_never_falls_back_to_plaintext() {
    let mut harness = Harness::new(Some(TestCa::new()));
    for (options, code) in [
        (
            ServerOptions {
                reject_auth_tls: true,
                ..Default::default()
            },
            "EFTPS_AUTH_TLS_REJECTED",
        ),
        (
            ServerOptions {
                reject_prot_p: true,
                ..Default::default()
            },
            "EFTPS_PROT_P_REJECTED",
        ),
    ] {
        let server = harness.tls_server(ServerTls::Explicit, options);
        harness.save(profile("r", "ftps", server.addr.port(), json!({})));
        assert_eq!(
            harness
                .connect("r", "fixture-password")
                .unwrap_err()
                .error
                .code,
            code
        );
        assert!(!server.log.sent("USER") && !server.log.sent("PASS"));
    }
    let server = harness.tls_server(
        ServerTls::Implicit,
        ServerOptions {
            reject_prot_p: true,
            ..Default::default()
        },
    );
    harness.save(profile(
        "r",
        "ftps",
        server.addr.port(),
        json!({"ftpTls": "implicit"}),
    ));
    assert_eq!(
        harness
            .connect("r", "fixture-password")
            .unwrap_err()
            .error
            .code,
        "EFTPS_PROT_P_REJECTED"
    );
    assert!(!server.log.sent("PASS"));
}

#[test]
fn listing_falls_back_to_list_and_keeps_missing_metadata_missing() {
    for format in [ListFormat::Unix, ListFormat::Dos] {
        let mut harness = Harness::new(None);
        let server = server(ServerOptions {
            mlsd: false,
            list_format: format,
            ..Default::default()
        });
        fs::create_dir(server.root.join("Папка с пробелами")).unwrap();
        fs::write(server.root.join("Папка с пробелами/файл.bin"), [1u8; 5]).unwrap();
        harness.save(profile(
            "l",
            "ftp",
            server.addr.port(),
            json!({"initialPath": "/Папка с пробелами"}),
        ));
        harness.connect("l", "fixture-password").unwrap();
        let connection = harness.manager.get("ftp:l").unwrap();
        let entries = connection.list("/Папка с пробелами").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/Папка с пробелами/файл.bin");
        assert_eq!(entries[0].size, Some(5));
        let properties = connection
            .properties("/Папка с пробелами/файл.bin")
            .unwrap();
        assert!(properties.permissions.is_none());
        assert!(!properties.capabilities.change_mode);
        assert_eq!(
            connection
                .properties("/Папка с пробелами")
                .unwrap()
                .entry_type,
            "directory"
        );
        assert_eq!(connection.stat_entry("/missing").unwrap(), None);
    }
}

/// The helper's view of connected FTP profiles.
struct Sessions(HashMap<String, Arc<FtpConnection>>);
impl RemoteSessions for Sessions {
    fn endpoint(&self, provider_id: &str) -> Result<Arc<dyn RemoteEndpoint>, NativeError> {
        Ok(Arc::new(
            self.0
                .get(provider_id)
                .cloned()
                .ok_or_else(super::pool::disconnected)?,
        ))
    }
}

fn operate(
    filesystem: &Filesystem,
    sessions: &Sessions,
    value: serde_json::Value,
) -> Result<OperationResult, NativeError> {
    let request: OperationRequest = serde_json::from_value(value).unwrap();
    remote_ops::operate(filesystem, sessions, request)
}

fn local() -> (PathBuf, Filesystem) {
    let root = fs::canonicalize(temp_root("local")).unwrap();
    let filesystem = Filesystem::from_root(root.clone(), root.clone()).unwrap();
    (root, filesystem)
}

fn connected(server: &FtpTestServer, id: &str) -> Arc<FtpConnection> {
    let mut harness = Harness::new(None);
    harness.save(profile(id, "ftp", server.addr.port(), json!({})));
    harness.connect(id, "fixture-password").unwrap();
    let connection = harness.manager.get(&format!("ftp:{id}")).unwrap();
    connection
}

#[test]
fn transfers_between_local_and_ftp_servers_preserve_content() {
    let (root, filesystem) = local();
    let (a, b) = (server(Default::default()), server(Default::default()));
    let sessions = Sessions(HashMap::from([
        ("ftp:a".to_string(), connected(&a, "a")),
        ("ftp:b".to_string(), connected(&b, "b")),
    ]));
    let big: Vec<u8> = (0..3_000_000u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
        .collect();
    fs::create_dir(root.join("tree")).unwrap();
    fs::write(root.join("tree/большой файл.bin"), &big).unwrap();
    fs::write(root.join("tree/empty.txt"), b"").unwrap();
    fs::create_dir(root.join("tree/nested")).unwrap();
    fs::write(root.join("tree/nested/note.txt"), "заметка").unwrap();
    let local_root = root.to_string_lossy().into_owned();
    // local -> FTP (recursive)
    operate(&filesystem, &sessions, json!({"action":"copy","filesystemId":"local","sourcePath":root.join("tree").to_string_lossy(),
        "targetFilesystemId":"ftp:a","targetDirectory":"/"})).unwrap();
    assert_eq!(
        sha256(&a.root.join("tree/большой файл.bin")),
        sha256(&root.join("tree/большой файл.bin"))
    );
    assert_eq!(fs::read(a.root.join("tree/empty.txt")).unwrap().len(), 0);
    // FTP -> FTP (different servers), then FTP -> local
    operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:a","sourcePath":"/tree",
        "targetFilesystemId":"ftp:b","targetDirectory":"/"}),
    )
    .unwrap();
    fs::create_dir(root.join("back")).unwrap();
    operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:b","sourcePath":"/tree",
        "targetFilesystemId":"local","targetDirectory":root.join("back").to_string_lossy()}),
    )
    .unwrap();
    assert_eq!(
        sha256(&root.join("back/tree/большой файл.bin")),
        sha256(&root.join("tree/большой файл.bin"))
    );
    assert_eq!(
        fs::read_to_string(root.join("back/tree/nested/note.txt")).unwrap(),
        "заметка"
    );
    // Same-server copy uses two sessions; same-server move renames.
    operate(&filesystem, &sessions, json!({"action":"copy","name":"copy.bin","filesystemId":"ftp:a","sourcePath":"/tree/большой файл.bin",
        "targetFilesystemId":"ftp:a","targetDirectory":"/tree"})).unwrap();
    assert_eq!(
        sha256(&a.root.join("tree/copy.bin")),
        sha256(&root.join("tree/большой файл.bin"))
    );
    operate(
        &filesystem,
        &sessions,
        json!({"action":"move","filesystemId":"ftp:a","sourcePath":"/tree/copy.bin",
        "targetFilesystemId":"ftp:a","targetDirectory":"/tree/nested"}),
    )
    .unwrap();
    assert!(a.root.join("tree/nested/copy.bin").exists() && !a.root.join("tree/copy.bin").exists());
    // An existing destination is never overwritten.
    let error = operate(&filesystem, &sessions, json!({"action":"copy","filesystemId":"local","sourcePath":root.join("tree/empty.txt").to_string_lossy(),
        "targetFilesystemId":"ftp:a","targetDirectory":"/tree"})).unwrap_err();
    assert_eq!(error.code, "EEXIST");
    // Cross-provider move removes the source only after the copy succeeded.
    operate(
        &filesystem,
        &sessions,
        json!({"action":"move","filesystemId":"ftp:b","sourcePath":"/tree",
        "targetFilesystemId":"local","targetDirectory":local_root}),
    )
    .unwrap_err(); // "tree" exists locally
    assert!(b.root.join("tree").exists());
    fs::create_dir(root.join("moved")).unwrap();
    operate(
        &filesystem,
        &sessions,
        json!({"action":"move","filesystemId":"ftp:b","sourcePath":"/tree",
        "targetFilesystemId":"local","targetDirectory":root.join("moved").to_string_lossy()}),
    )
    .unwrap();
    assert!(!b.root.join("tree").exists() && root.join("moved/tree/nested/note.txt").exists());
    // create, rename and recursive delete
    operate(&filesystem, &sessions, json!({"action":"create-folder","name":"Новая папка","targetFilesystemId":"ftp:a","targetDirectory":"/"})).unwrap();
    operate(&filesystem, &sessions, json!({"action":"create-file","name":"пусто.txt","targetFilesystemId":"ftp:a","targetDirectory":"/Новая папка"})).unwrap();
    operate(&filesystem, &sessions, json!({"action":"rename","name":"Переименовано","filesystemId":"ftp:a","sourcePath":"/Новая папка"})).unwrap();
    assert!(a.root.join("Переименовано/пусто.txt").exists());
    operate(
        &filesystem,
        &sessions,
        json!({"action":"delete","filesystemId":"ftp:a","sourcePath":"/tree"}),
    )
    .unwrap();
    assert!(!a.root.join("tree").exists());
}

#[test]
fn final_errors_after_all_bytes_fail_and_remove_the_partial_destination() {
    let (root, filesystem) = local();
    fs::write(root.join("upload.bin"), vec![3u8; 400_000]).unwrap();
    for code in [451, 552] {
        let rejecting = server(ServerOptions {
            stor_final_error: Some(code),
            ..Default::default()
        });
        let sessions = Sessions(HashMap::from([(
            "ftp:r".to_string(),
            connected(&rejecting, "r"),
        )]));
        let error = operate(&filesystem, &sessions, json!({"action":"copy","filesystemId":"local","sourcePath":root.join("upload.bin").to_string_lossy(),
            "targetFilesystemId":"ftp:r","targetDirectory":"/"})).unwrap_err();
        assert_eq!(error.code, "EFTP_TRANSFER", "{code}");
        assert!(
            !rejecting.root.join("upload.bin").exists(),
            "{code}: partial upload removed"
        );
        // A move keeps its source when the upload failed.
        operate(&filesystem, &sessions, json!({"action":"move","filesystemId":"local","sourcePath":root.join("upload.bin").to_string_lossy(),
            "targetFilesystemId":"ftp:r","targetDirectory":"/"})).unwrap_err();
        assert!(root.join("upload.bin").exists());
    }
    let failing = server(ServerOptions {
        retr_final_error: Some(451),
        ..Default::default()
    });
    fs::write(failing.root.join("download.bin"), vec![4u8; 400_000]).unwrap();
    let sessions = Sessions(HashMap::from([(
        "ftp:d".to_string(),
        connected(&failing, "d"),
    )]));
    let error = operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:d","sourcePath":"/download.bin",
        "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()}),
    )
    .unwrap_err();
    assert_eq!(error.code, "EFTP_TRANSFER");
    assert!(!root.join("download.bin").exists());
}

#[test]
fn cancelled_and_stalled_transfers_stop_clean_up_and_release_sessions() {
    let (root, filesystem) = local();
    // Throttled to ~1 MB/s: the deadline (cancellation) fires mid-file.
    let slow = server(ServerOptions {
        throttle: 1_000_000,
        ..Default::default()
    });
    fs::write(slow.root.join("large.bin"), vec![9u8; 5_000_000]).unwrap();
    let connection = connected(&slow, "slow");
    let sessions = Sessions(HashMap::from([(
        "ftp:slow".to_string(),
        Arc::clone(&connection),
    )]));
    crate::filesystem::jobs::set_test_deadline(Some(
        std::time::Instant::now() + Duration::from_millis(700),
    ));
    let error = operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:slow","sourcePath":"/large.bin",
        "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()}),
    )
    .unwrap_err();
    crate::filesystem::jobs::set_test_deadline(None);
    assert_eq!(error.code, "ETIMEDOUT");
    assert!(!root.join("large.bin").exists());
    // The aborted session was discarded, not returned to the pool.
    assert!(connection.open_sessions() <= 1);
    // A repeated transfer after the cancellation succeeds.
    operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:slow","sourcePath":"/large.bin",
        "targetFilesystemId":"local","targetDirectory":root.to_string_lossy()}),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(root.join("large.bin")).unwrap().len(),
        5_000_000
    );
    // A server that stops sending is ended by the socket timeout.
    let stalled = server(ServerOptions {
        stall_retr_after: Some(100_000),
        ..Default::default()
    });
    fs::write(stalled.root.join("stall.bin"), vec![1u8; 2_000_000]).unwrap();
    let sessions = Sessions(HashMap::from([(
        "ftp:s".to_string(),
        connected(&stalled, "s"),
    )]));
    fs::create_dir(root.join("stall")).unwrap();
    let started = std::time::Instant::now();
    let error = operate(
        &filesystem,
        &sessions,
        json!({"action":"copy","filesystemId":"ftp:s","sourcePath":"/stall.bin",
        "targetFilesystemId":"local","targetDirectory":root.join("stall").to_string_lossy()}),
    )
    .unwrap_err();
    assert!(
        matches!(error.code.as_str(), "ETIMEDOUT" | "EFTP_TRANSFER"),
        "{error:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(!root.join("stall/stall.bin").exists());
}

#[test]
fn concurrent_listing_and_downloads_use_separate_sessions_within_the_limit() {
    let slow = server(ServerOptions {
        throttle: 2_000_000,
        ..Default::default()
    });
    for name in ["a.bin", "b.bin", "c.bin"] {
        fs::write(slow.root.join(name), vec![5u8; 1_000_000]).unwrap();
    }
    let connection = connected(&slow, "pool");
    let readers: Vec<_> = ["a.bin", "b.bin", "c.bin"]
        .iter()
        .map(|name| connection.open_reader(&format!("/{name}")).unwrap())
        .collect();
    // Listing still works while three downloads are in flight.
    assert_eq!(connection.list("/").unwrap().len(), 3);
    assert_eq!(connection.open_sessions(), 4);
    let handles: Vec<_> = readers
        .into_iter()
        .map(|mut reader| {
            std::thread::spawn(move || {
                let mut bytes = vec![];
                std::io::Read::read_to_end(&mut reader, &mut bytes).unwrap();
                reader.finish().unwrap();
                bytes.len()
            })
        })
        .collect();
    for handle in handles {
        assert_eq!(handle.join().unwrap(), 1_000_000);
    }
    assert!(
        slow.log
            .peak_controls
            .load(std::sync::atomic::Ordering::SeqCst)
            <= 4
    );
    assert_eq!(connection.idle_sessions(), 4);
    // Reconnect: idle sessions lost by the server are replaced transparently
    // for repeatable operations.
    connection.sever_idle();
    assert_eq!(connection.list("/").unwrap().len(), 3);
    connection.close();
    assert!(slow.wait_for_closed_controls(Duration::from_secs(5)));
}

#[test]
fn profile_changes_and_forget_close_ftp_sessions_through_remote_providers() {
    let server = server(Default::default());
    let mut harness = Harness::new(None);
    harness.save(profile(
        "life",
        "ftp",
        server.addr.port(),
        json!({"savePassword": true}),
    ));
    let ssh = crate::ssh::SshManager::new();
    let providers = crate::remote::RemoteProviders::with_ftp(ssh, Arc::clone(&harness.manager));
    harness.connect("life", "fixture-password").unwrap();
    assert!(providers.list("ftp:life", "/").is_ok());
    let saved: ConnectionProfile = harness.manager.get("ftp:life").unwrap().profile.clone();
    providers.disconnect_profile(&saved);
    assert_eq!(
        providers.list("ftp:life", "/").unwrap_err().code,
        "EFTP_DISCONNECTED"
    );
    assert!(server.wait_for_closed_controls(Duration::from_secs(5)));
    // An SFTP profile with another id never closes this FTP session.
    harness.connect("life", "").unwrap();
    providers.disconnect_profile(&crate::connections::test_profile("auto"));
    assert!(providers.list("ftp:life", "/").is_ok());
}
