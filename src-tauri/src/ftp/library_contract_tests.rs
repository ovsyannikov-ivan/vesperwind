//! Proof of concept and contract tests for the `suppaftp` client against the
//! local test server: plain FTP, explicit and implicit FTPS, certificate
//! checks, session reuse, streaming transfers, final transfer replies,
//! timeouts and secret-free logging. They exercise the library directly, so a
//! dependency update that changes this behavior fails here first.
use super::test_certs::{self_signed, TestCa};
use super::test_server::{FtpTestServer, ServerOptions, ServerTls};
use rustls::{pki_types::CertificateDer, ClientConfig};
use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use suppaftp::{FtpError, Mode, RustlsConnector, RustlsFtpStream, TransferStream};

pub(crate) fn temp_root(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("vesper-ftp-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A client configuration trusting the platform roots plus `extra`.
fn client_config(extra: Vec<CertificateDer<'static>>) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        rustls_platform_verifier::Verifier::new_with_extra_roots(extra, provider.clone()).unwrap();
    Arc::new(
        ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth(),
    )
}

/// Ends an upload's data connection the way servers expect: flush, TLS
/// close_notify, half-close, then read until the server closes, so unread
/// TLS session tickets cannot turn the close into a TCP reset.
fn close_upload<T>(stream: &mut TransferStream<T>) -> std::io::Result<()>
where
    T: suppaftp::TlsStream<InnerStream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>>,
{
    use suppaftp::DataStream;
    let mut buffer = [0u8; 4096];
    match stream.get_mut() {
        DataStream::Ssl(tls) => {
            let inner = tls.mut_ref();
            inner.flush()?;
            inner.conn.send_close_notify();
            while inner.conn.wants_write() {
                inner.conn.write_tls(&mut inner.sock)?;
            }
            inner.sock.shutdown(Shutdown::Write)?;
            loop {
                match inner.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(error),
                }
            }
        }
        DataStream::Tcp(tcp) => {
            tcp.flush()?;
            tcp.shutdown(Shutdown::Write)?;
            while tcp.read(&mut buffer)? > 0 {}
        }
    }
    Ok(())
}

fn timeouts(addr: SocketAddr) -> RustlsFtpStream {
    let stream = RustlsFtpStream::connect_timeout(addr, Duration::from_secs(5))
        .unwrap()
        .passive_stream_builder(|addr| {
            let socket = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
                .map_err(FtpError::ConnectionError)?;
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(FtpError::ConnectionError)?;
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .map_err(FtpError::ConnectionError)?;
            Ok(socket)
        });
    stream
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
}

fn tls_server(tls: ServerTls, ca: &TestCa, options: ServerOptions) -> FtpTestServer {
    let leaf = ca.leaf(&["localhost", "127.0.0.1"], false);
    let config = super::test_server::tls_config(leaf.chain, leaf.key).unwrap();
    FtpTestServer::start(
        temp_root("contract"),
        ServerOptions {
            tls,
            tls_config: Some(config),
            ..options
        },
    )
    .unwrap()
}

fn exercise_operations(ftp: &mut RustlsFtpStream) {
    ftp.set_mode(Mode::ExtendedPassive);
    ftp.mkdir("/Папка с пробелами").unwrap();
    let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let mut upload = ftp.put_with_stream("/Папка с пробелами/файл.bin").unwrap();
    upload.write_all(&payload).unwrap();
    upload.flush().unwrap();
    close_upload(&mut upload).unwrap();
    upload.finish().unwrap();
    let mut download = ftp.retr_as_stream("/Папка с пробелами/файл.bin").unwrap();
    let mut received = vec![];
    download.read_to_end(&mut received).unwrap();
    download.finish().unwrap();
    assert_eq!(received, payload);
    let listing = ftp.mlsd(Some("/Папка с пробелами")).unwrap();
    assert!(listing.iter().any(|line| line.ends_with(" файл.bin")));
    assert!(ftp
        .list(Some("/Папка с пробелами"))
        .unwrap()
        .iter()
        .any(|line| line.ends_with(" файл.bin")));
    assert_eq!(
        ftp.size("/Папка с пробелами/файл.bin").unwrap(),
        payload.len()
    );
    ftp.rename(
        "/Папка с пробелами/файл.bin",
        "/Папка с пробелами/renamed.bin",
    )
    .unwrap();
    ftp.rm("/Папка с пробелами/renamed.bin").unwrap();
    ftp.rmdir("/Папка с пробелами").unwrap();
    ftp.quit().unwrap();
}

#[test]
fn plain_ftp_supports_the_needed_commands_and_streams() {
    let server = FtpTestServer::start(temp_root("plain"), ServerOptions::default()).unwrap();
    let mut ftp = timeouts(server.addr);
    ftp.login("fixture", "fixture-password").unwrap();
    exercise_operations(&mut ftp);
}

#[test]
fn explicit_ftps_secures_control_and_data_before_credentials() {
    let ca = TestCa::new();
    let server = tls_server(
        ServerTls::Explicit,
        &ca,
        ServerOptions {
            require_session_reuse: true,
            ..Default::default()
        },
    );
    let connector = RustlsConnector::from(client_config(vec![ca.der.clone()]));
    let mut ftp = timeouts(server.addr)
        .into_secure(connector, "localhost")
        .unwrap();
    ftp.login("fixture", "fixture-password").unwrap();
    exercise_operations(&mut ftp);
    let commands = server.log.commands.lock().unwrap().clone();
    let position = |prefix: &str| commands.iter().position(|c| c.starts_with(prefix)).unwrap();
    assert!(position("AUTH TLS") < position("PBSZ 0"));
    assert!(position("PBSZ 0") < position("PROT P"));
    assert!(position("PROT P") < position("USER"));
    // Every data connection was TLS and resumed the control session.
    let resumed = server.log.data_tls_resumed.lock().unwrap().clone();
    assert!(!resumed.is_empty() && resumed.iter().all(|value| *value));
}

#[test]
fn implicit_ftps_starts_tls_before_the_greeting() {
    let ca = TestCa::new();
    let server = tls_server(
        ServerTls::Implicit,
        &ca,
        ServerOptions {
            require_session_reuse: true,
            ..Default::default()
        },
    );
    let connector = RustlsConnector::from(client_config(vec![ca.der.clone()]));
    let mut ftp =
        RustlsFtpStream::connect_secure_implicit(server.addr, connector, "localhost").unwrap();
    ftp.get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    ftp.login("fixture", "fixture-password").unwrap();
    // The library does not send PBSZ/PROT for implicit FTPS; the client does.
    ftp.custom_command("PBSZ 0", &[suppaftp::Status::CommandOk])
        .unwrap();
    ftp.custom_command("PROT P", &[suppaftp::Status::CommandOk])
        .unwrap();
    exercise_operations(&mut ftp);
    assert!(server
        .log
        .data_tls_resumed
        .lock()
        .unwrap()
        .iter()
        .all(|value| *value));
}

#[test]
fn untrusted_or_mismatched_certificates_never_reach_user_or_pass() {
    let ca = TestCa::new();
    let other_ca = TestCa::new();
    for (label, server) in [
        (
            "unknown CA",
            tls_server(ServerTls::Explicit, &other_ca, Default::default()),
        ),
        ("self-signed", {
            let leaf = self_signed(&["localhost"]);
            FtpTestServer::start(
                temp_root("self-signed"),
                ServerOptions {
                    tls: ServerTls::Explicit,
                    tls_config: Some(super::test_server::tls_config(leaf.chain, leaf.key).unwrap()),
                    ..Default::default()
                },
            )
            .unwrap()
        }),
        ("wrong host", {
            let leaf = ca.leaf(&["other.invalid"], false);
            FtpTestServer::start(
                temp_root("wrong-host"),
                ServerOptions {
                    tls: ServerTls::Explicit,
                    tls_config: Some(super::test_server::tls_config(leaf.chain, leaf.key).unwrap()),
                    ..Default::default()
                },
            )
            .unwrap()
        }),
        ("expired", {
            let leaf = ca.leaf(&["localhost"], true);
            FtpTestServer::start(
                temp_root("expired"),
                ServerOptions {
                    tls: ServerTls::Explicit,
                    tls_config: Some(super::test_server::tls_config(leaf.chain, leaf.key).unwrap()),
                    ..Default::default()
                },
            )
            .unwrap()
        }),
    ] {
        let connector = RustlsConnector::from(client_config(vec![ca.der.clone()]));
        let result = timeouts(server.addr).into_secure(connector, "localhost");
        // rustls reports the certificate failure through the I/O layer.
        assert!(result.is_err(), "{label}");
        assert!(!server.log.sent("USER"), "{label}");
        assert!(!server.log.sent("PASS"), "{label}");
    }
}

#[test]
fn rejected_auth_tls_or_prot_p_is_an_error_not_a_downgrade() {
    let ca = TestCa::new();
    for options in [
        ServerOptions {
            reject_auth_tls: true,
            ..Default::default()
        },
        ServerOptions {
            reject_prot_p: true,
            ..Default::default()
        },
    ] {
        let server = tls_server(ServerTls::Explicit, &ca, options);
        let connector = RustlsConnector::from(client_config(vec![ca.der.clone()]));
        assert!(timeouts(server.addr)
            .into_secure(connector, "localhost")
            .is_err());
        assert!(!server.log.sent("USER") && !server.log.sent("PASS"));
    }
}

#[test]
fn final_transfer_errors_are_reported_after_all_bytes() {
    for (stor, retr) in [(Some(451), None), (Some(552), None), (None, Some(451))] {
        let server = FtpTestServer::start(
            temp_root("final"),
            ServerOptions {
                stor_final_error: stor,
                retr_final_error: retr,
                ..Default::default()
            },
        )
        .unwrap();
        std::fs::write(server.root.join("source.bin"), vec![7u8; 100_000]).unwrap();
        let mut ftp = timeouts(server.addr);
        ftp.login("fixture", "fixture-password").unwrap();
        if stor.is_some() {
            let mut upload = ftp.put_with_stream("/upload.bin").unwrap();
            upload.write_all(&vec![1u8; 100_000]).unwrap();
            close_upload(&mut upload).unwrap();
            assert!(upload.finish().is_err());
        } else {
            let mut download = ftp.retr_as_stream("/source.bin").unwrap();
            let mut bytes = vec![];
            download.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes.len(), 100_000);
            assert!(download.finish().is_err());
        }
        // The control connection stays usable after a reported failure.
        ftp.noop().unwrap();
    }
}

#[test]
fn servers_without_mlsd_still_answer_list_in_unix_and_dos_formats() {
    use super::test_server::ListFormat;
    for format in [ListFormat::Unix, ListFormat::Dos] {
        let server = FtpTestServer::start(
            temp_root("list"),
            ServerOptions {
                mlsd: false,
                list_format: format,
                ..Default::default()
            },
        )
        .unwrap();
        std::fs::write(server.root.join("файл с пробелом.txt"), b"x").unwrap();
        std::fs::create_dir(server.root.join("dir")).unwrap();
        let mut ftp = timeouts(server.addr);
        ftp.login("anonymous", "guest").unwrap();
        assert!(ftp.mlsd(Some("/")).is_err());
        let lines = ftp.list(Some("/")).unwrap();
        assert!(lines
            .iter()
            .any(|line| line.ends_with("файл с пробелом.txt")));
        assert!(lines.iter().any(|line| line.ends_with("dir")));
        ftp.quit().unwrap();
        assert!(server.wait_for_closed_controls(Duration::from_secs(5)));
    }
}

#[test]
fn stalled_data_connections_time_out() {
    let server = FtpTestServer::start(
        temp_root("stall"),
        ServerOptions {
            stall_retr_after: Some(1024),
            ..Default::default()
        },
    )
    .unwrap();
    std::fs::write(server.root.join("big.bin"), vec![0u8; 1_000_000]).unwrap();
    let mut ftp = timeouts(server.addr);
    ftp.login("fixture", "fixture-password").unwrap();
    let mut download = ftp.retr_as_stream("/big.bin").unwrap();
    let started = std::time::Instant::now();
    let mut buffer = vec![0u8; 64 * 1024];
    let error = loop {
        match download.read(&mut buffer) {
            Ok(0) => panic!("stalled transfer must not end cleanly"),
            Ok(_) => continue,
            Err(error) => break error,
        }
    };
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ));
    assert!(started.elapsed() < Duration::from_secs(10));
}

/// Records log lines from every crate, at trace level.
struct CaptureLogger;
static CAPTURED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
impl log::Log for CaptureLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        CAPTURED
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .push(format!("{} {}", record.target(), record.args()));
    }
    fn flush(&self) {}
}

#[test]
fn trace_logging_never_contains_the_password() {
    let _ = log::set_logger(&CaptureLogger);
    log::set_max_level(log::LevelFilter::Trace);
    let server = FtpTestServer::start(temp_root("logging"), ServerOptions::default()).unwrap();
    let mut ftp = timeouts(server.addr);
    ftp.login("fixture", "fixture-password").unwrap();
    ftp.quit().unwrap();
    let lines = CAPTURED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .clone();
    assert!(!lines.iter().any(|line| line.contains("fixture-password")));
    if log::STATIC_MAX_LEVEL == log::LevelFilter::Off {
        // ssh2-config's `nolog` compiles every `log` macro out of this binary.
        // The vendored suppaftp still redacts PASS if that ever changes
        // (vendor/suppaftp: loggable_commands_never_contain_a_password).
        assert!(lines.is_empty());
    } else {
        assert!(lines.iter().any(|line| line.contains("CC OUT: PASS ****")));
    }
}
