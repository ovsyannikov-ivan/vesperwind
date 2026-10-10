//! One authenticated FTP/FTPS control connection and its data transfers.
//!
//! A session runs one command or transfer at a time. Explicit FTPS performs
//! `AUTH TLS`, `PBSZ 0` and `PROT P` before `USER`; implicit FTPS starts TLS on
//! connect and then requires `PBSZ 0` and `PROT P`. Every data connection uses
//! the control session's TLS configuration, so certificate checks repeat and
//! TLS sessions resume. There is no fallback to a clear data channel.
use super::{
    errors::{ftp_error, io_error, is_connection_lost, reply_code},
    listing::{parse_listing, parse_mlst_fact, FtpEntry, Listing},
    tls::{client_config, CertificateDetails, TlsPolicy},
};
use crate::error::NativeError;
use rustls::{ClientConnection, StreamOwned};
use std::{
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};
use suppaftp::{
    types::FileType, DataStream, FtpError, Mode, RustlsConnector, RustlsFtpStream, Status,
    TransferStream,
};
use zeroize::Zeroizing;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounds every blocking socket read or write. A transfer that makes no
/// progress for this long fails instead of hanging. It is shorter than the
/// helper's idle timeout (`jobs::IDLE_TIMEOUT_MS`).
#[cfg(not(test))]
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Security {
    Plain,
    Explicit,
    Implicit,
}

pub struct ConnectSpec {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password: Zeroizing<String>,
    pub pin: Option<String>,
    pub extra_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub mlsd: bool,
    pub mlst: bool,
    pub utf8: bool,
    pub size: bool,
    pub mdtm: bool,
    pub rest: bool,
    pub epsv: bool,
}

#[derive(Debug)]
pub struct ConnectFailure {
    pub error: NativeError,
    /// Present when the server's certificate was rejected.
    pub certificate: Option<Box<CertificateDetails>>,
    /// The server rejected the credentials.
    pub authentication: bool,
}

impl From<NativeError> for ConnectFailure {
    fn from(error: NativeError) -> Self {
        Self {
            error,
            certificate: None,
            authentication: false,
        }
    }
}

pub type DataTransfer = TransferStream<<RustlsFtpStream as Session>::Tls>;

/// Names the private TLS stream type of `RustlsFtpStream`.
pub trait Session {
    type Tls: suppaftp::TlsStream<InnerStream = StreamOwned<ClientConnection, TcpStream>>;
}
impl<T> Session for suppaftp::ImplFtpStream<T>
where
    T: suppaftp::TlsStream<InnerStream = StreamOwned<ClientConnection, TcpStream>>,
{
    type Tls = T;
}

pub struct FtpSession {
    stream: RustlsFtpStream,
    pub capabilities: Capabilities,
}

fn configured_socket(addr: &SocketAddr) -> io::Result<TcpStream> {
    let socket = TcpStream::connect_timeout(addr, CONNECT_TIMEOUT)?;
    socket.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    socket.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    socket.set_nodelay(true)?;
    Ok(socket)
}

/// Connects to the first reachable address of `host` (IPv6 and IPv4).
fn connect_host(host: &str, port: u16) -> Result<TcpStream, NativeError> {
    let addresses: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| {
            NativeError::new("EFTP_RESOLVE", "Unable to resolve the FTP server address")
                .with_native_error(e.kind().to_string())
        })?
        .collect();
    let mut last = None;
    for address in &addresses {
        match configured_socket(address) {
            Ok(socket) => return Ok(socket),
            Err(error) => last = Some(error),
        }
    }
    Err(match last {
        Some(error) => NativeError::from_io(&error, "Unable to connect to the FTP server")
            .with_native_error(error.kind().to_string()),
        None => NativeError::new("EFTP_RESOLVE", "Unable to resolve the FTP server address"),
    })
}

impl FtpSession {
    pub fn connect(spec: &ConnectSpec) -> Result<Self, ConnectFailure> {
        let tls = match spec.security {
            Security::Plain => None,
            _ => Some(
                client_config(&TlsPolicy {
                    host: spec.host.clone(),
                    port: spec.port,
                    pin: spec.pin.clone(),
                    extra_roots: spec.extra_roots.clone(),
                })
                .map_err(|e| {
                    NativeError::new("ETLS", "Unable to prepare the secure connection")
                        .with_native_error(e.to_string())
                })?,
            ),
        };
        let tls_failure = |error: &FtpError| -> ConnectFailure {
            let certificate = tls
                .as_ref()
                .and_then(|tls| tls.rejection.lock().ok().and_then(|value| value.clone()));
            match certificate {
                Some(certificate) => ConnectFailure {
                    error: NativeError::new(
                        match certificate.reason {
                            "changed" => "ETLS_CERTIFICATE_CHANGED",
                            "expired" | "notYetValid" => "ETLS_CERTIFICATE_EXPIRED",
                            "hostname" => "ETLS_CERTIFICATE_HOSTNAME",
                            _ => "ETLS_CERTIFICATE_UNTRUSTED",
                        },
                        if certificate.reason == "changed" {
                            "The FTPS server presented a different certificate than the trusted one"
                        } else {
                            "The FTPS server certificate is not trusted"
                        },
                    ),
                    certificate: Some(Box::new(certificate)),
                    authentication: false,
                },
                None => ConnectFailure::from(ftp_error(error, None)),
            }
        };
        let socket = connect_host(&spec.host, spec.port)?;
        let builder =
            |addr: SocketAddr| configured_socket(&addr).map_err(FtpError::ConnectionError);
        let mut stream = match (spec.security, tls.as_ref()) {
            (Security::Implicit, Some(tls)) => {
                RustlsFtpStream::connect_secure_implicit_with_stream(
                    socket,
                    RustlsConnector::from(tls.config.clone()),
                    &spec.host,
                )
                .map_err(|e| tls_failure(&e))?
            }
            _ => RustlsFtpStream::connect_with_stream(socket)
                .map_err(|e| ConnectFailure::from(ftp_error(&e, None)))?,
        }
        .passive_stream_builder(builder);
        stream.set_passive_nat_workaround(true);
        match (spec.security, tls.as_ref()) {
            (Security::Explicit, Some(tls)) => {
                // AUTH TLS, TLS handshake, PBSZ 0 and PROT P. Any refusal is an
                // error; the session never continues in clear text.
                stream = stream
                    .into_secure(RustlsConnector::from(tls.config.clone()), &spec.host)
                    .map_err(|e| match reply_code(&e) {
                        Some(code) if (500..=504).contains(&code) || code == 534 => {
                            ConnectFailure::from(
                                NativeError::new(
                                    "EFTPS_AUTH_TLS_REJECTED",
                                    "The FTP server does not offer explicit TLS (AUTH TLS)",
                                )
                                .with_native_error(code.to_string()),
                            )
                        }
                        Some(code) => ConnectFailure::from(
                            NativeError::new(
                                "EFTPS_PROT_P_REJECTED",
                                "The FTP server refused to protect the data connection (PROT P)",
                            )
                            .with_native_error(code.to_string()),
                        ),
                        None => tls_failure(&e),
                    })?;
            }
            (Security::Implicit, Some(_)) => {
                for command in ["PBSZ 0", "PROT P"] {
                    stream
                        .custom_command(command, &[Status::CommandOk])
                        .map_err(|e| {
                            ConnectFailure::from(
                                NativeError::new(
                                    "EFTPS_PROT_P_REJECTED",
                                    "The FTP server refused to protect the data connection (PROT P)",
                                )
                                .with_native_error(
                                    reply_code(&e).map(|c| c.to_string()).unwrap_or_default(),
                                ),
                            )
                        })?;
                }
            }
            _ => {}
        }
        // Only now, on a verified connection (or an acknowledged plain one),
        // are credentials sent.
        if let Err(error) = stream.login(spec.username.as_str(), spec.password.as_str()) {
            return Err(match reply_code(&error) {
                Some(530 | 331 | 332 | 430) => ConnectFailure {
                    error: NativeError::new(
                        "EAUTHENTICATION_REQUIRED",
                        "The FTP server rejected the user name or password",
                    ),
                    certificate: None,
                    authentication: true,
                },
                // The reply text of a failed login is never kept.
                _ => ConnectFailure::from(NativeError::new(
                    if is_connection_lost(&error) {
                        "EFTP_DISCONNECTED"
                    } else {
                        "EFTP"
                    },
                    "The FTP login failed",
                )),
            });
        }
        let mut session = Self {
            stream,
            capabilities: Capabilities::default(),
        };
        session.negotiate();
        session
            .stream
            .transfer_type(FileType::Binary)
            .map_err(|e| ConnectFailure::from(ftp_error(&e, None)))?;
        Ok(session)
    }

    /// Reads FEAT and enables UTF-8 when offered. Servers without FEAT get
    /// the conservative defaults (LIST, PASV).
    fn negotiate(&mut self) {
        if let Ok(features) = self.stream.feat() {
            let has = |name: &str| features.keys().any(|key| key.eq_ignore_ascii_case(name));
            self.capabilities = Capabilities {
                mlsd: has("MLST"),
                mlst: has("MLST"),
                utf8: has("UTF8"),
                size: has("SIZE"),
                mdtm: has("MDTM"),
                rest: features.iter().any(|(k, v)| {
                    k.eq_ignore_ascii_case("REST")
                        && v.as_deref()
                            .is_some_and(|v| v.eq_ignore_ascii_case("STREAM"))
                }),
                epsv: has("EPSV"),
            };
        }
        if self.capabilities.utf8 {
            let _ = self.stream.opts("UTF8", Some("ON"));
        }
        self.stream.set_mode(if self.capabilities.epsv {
            Mode::ExtendedPassive
        } else {
            Mode::Passive
        });
    }

    /// Runs a data command, falling back from EPSV to PASV once when the
    /// server does not understand EPSV. The data command itself was not sent.
    fn with_passive_fallback<T>(
        &mut self,
        mut run: impl FnMut(&mut RustlsFtpStream) -> Result<T, FtpError>,
    ) -> Result<T, FtpError> {
        match run(&mut self.stream) {
            Err(error)
                if self.capabilities.epsv && matches!(reply_code(&error), Some(500..=502)) =>
            {
                self.capabilities.epsv = false;
                self.stream.set_mode(Mode::Passive);
                run(&mut self.stream)
            }
            other => other,
        }
    }

    pub fn noop(&mut self) -> Result<(), NativeError> {
        self.stream.noop().map_err(|e| ftp_error(&e, None))
    }

    pub fn pwd(&mut self) -> Result<String, NativeError> {
        self.stream.pwd().map_err(|e| ftp_error(&e, None))
    }

    pub fn list(&mut self, path: &str) -> Result<Listing, (NativeError, bool)> {
        if self.capabilities.mlsd {
            match self.with_passive_fallback(|stream| stream.mlsd(Some(path))) {
                Ok(lines) => return Ok(parse_listing(&lines, true)),
                Err(error) if matches!(reply_code(&error), Some(500..=502)) => {
                    self.capabilities.mlsd = false;
                }
                Err(error) => {
                    return Err((ftp_error(&error, Some(path)), is_connection_lost(&error)))
                }
            }
        }
        self.with_passive_fallback(|stream| stream.list(Some(path)))
            .map(|lines| parse_listing(&lines, false))
            .map_err(|error| (ftp_error(&error, Some(path)), is_connection_lost(&error)))
    }

    /// The entry at `path`, or `None` if the server says it does not exist.
    pub fn stat(&mut self, path: &str) -> Result<Option<FtpEntry>, (NativeError, bool)> {
        if path == "/" {
            return Ok(Some(super::root_entry()));
        }
        if self.capabilities.mlst {
            match self.stream.mlst(Some(path)) {
                Ok(fact) => {
                    if let Some(mut entry) = parse_mlst_fact(fact.trim()) {
                        entry.name = super::remote_name(path).to_string();
                        return Ok(Some(entry));
                    }
                }
                Err(error) if matches!(reply_code(&error), Some(450 | 550)) => return Ok(None),
                Err(error) if matches!(reply_code(&error), Some(500..=502)) => {
                    self.capabilities.mlst = false;
                }
                Err(error) => {
                    return Err((ftp_error(&error, Some(path)), is_connection_lost(&error)))
                }
            }
        }
        // Without MLST, look the name up in its parent's listing.
        let name = super::remote_name(path);
        match self.list(&super::remote_parent(path)) {
            Ok(listing) => Ok(listing.entries.into_iter().find(|entry| entry.name == name)),
            Err((error, lost)) if !lost && error.code == "EFTP_UNAVAILABLE" => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn mkdir(&mut self, path: &str) -> Result<(), NativeError> {
        self.stream
            .mkdir(path)
            .map_err(|e| ftp_error(&e, Some(path)))
    }
    pub fn rmdir(&mut self, path: &str) -> Result<(), NativeError> {
        self.stream
            .rmdir(path)
            .map_err(|e| ftp_error(&e, Some(path)))
    }
    pub fn delete(&mut self, path: &str) -> Result<(), NativeError> {
        self.stream.rm(path).map_err(|e| ftp_error(&e, Some(path)))
    }
    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), NativeError> {
        self.stream
            .rename(from, to)
            .map_err(|e| ftp_error(&e, Some(from)))
    }

    pub fn retrieve(&mut self, path: &str) -> Result<DataTransfer, (NativeError, bool)> {
        self.with_passive_fallback(|stream| stream.retr_as_stream(path))
            .map_err(|error| (ftp_error(&error, Some(path)), is_connection_lost(&error)))
    }

    pub fn store(&mut self, path: &str) -> Result<DataTransfer, (NativeError, bool)> {
        self.with_passive_fallback(|stream| stream.put_with_stream(path))
            .map_err(|error| (ftp_error(&error, Some(path)), is_connection_lost(&error)))
    }

    /// Breaks the control connection, so a pending transfer reply can never
    /// block. Used before dropping an aborted transfer.
    pub fn sever(&self) {
        let _ = self.stream.get_ref().shutdown(Shutdown::Both);
    }

    pub fn quit(mut self) {
        let _ = self.stream.quit();
    }
}

/// Ends a download after the data reached end-of-file: closes the data
/// connection and checks the server's final reply.
pub fn finish_download(transfer: DataTransfer, path: &str) -> Result<(), NativeError> {
    transfer.finish().map_err(|e| ftp_error(&e, Some(path)))
}

/// Ends an upload: flush, TLS `close_notify`, half-close, read until the
/// server closes (so unread TLS session tickets cannot turn the close into a
/// reset), then check the final reply. All bytes being written is not a
/// success until the server confirms the transfer.
pub fn finish_upload(mut transfer: DataTransfer, path: &str) -> Result<(), NativeError> {
    close_upload(&mut transfer)
        .map_err(|e| io_error(&e, path, "The FTP upload could not be completed"))?;
    transfer.finish().map_err(|e| ftp_error(&e, Some(path)))
}

fn close_upload(transfer: &mut DataTransfer) -> io::Result<()> {
    let mut buffer = [0u8; 4096];
    match transfer.get_mut() {
        DataStream::Ssl(tls) => {
            let inner = suppaftp::TlsStream::mut_ref(tls.as_mut());
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
                    // A server may close the TCP connection without close_notify.
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
                        ) =>
                    {
                        break
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        DataStream::Tcp(tcp) => {
            tcp.flush()?;
            tcp.shutdown(Shutdown::Write)?;
            loop {
                match tcp.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(e) if e.kind() == io::ErrorKind::ConnectionReset => break,
                    Err(e) => return Err(e),
                }
            }
        }
    }
    Ok(())
}
