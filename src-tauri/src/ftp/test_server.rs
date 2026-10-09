//! A small, controllable FTP/FTPS server for tests and the debug-only native
//! acceptance. It serves a directory on disk over plain FTP, explicit FTPS
//! (`AUTH TLS`) or implicit FTPS, and can inject the failures the client must
//! handle: rejected `AUTH TLS` or `PROT P`, required TLS session reuse on data
//! connections, a final error after all bytes were transferred, stalled and
//! throttled transfers, and servers without `MLSD`. Credentials are synthetic.
//! It is never part of a release build.
use rustls::{pki_types::CertificateDer, ServerConfig, ServerConnection, StreamOwned};
use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerTls {
    None,
    Explicit,
    Implicit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListFormat {
    Unix,
    Dos,
}

#[derive(Clone)]
pub struct ServerOptions {
    pub tls: ServerTls,
    pub tls_config: Option<Arc<ServerConfig>>,
    /// Users and their passwords. `anonymous` logs in with any password.
    pub users: HashMap<String, String>,
    pub allow_anonymous: bool,
    pub reject_auth_tls: bool,
    pub reject_prot_p: bool,
    /// Refuse a TLS data connection that did not resume the control session.
    pub require_session_reuse: bool,
    /// Without MLSD/MLST the client must fall back to LIST.
    pub mlsd: bool,
    pub list_format: ListFormat,
    /// Final reply after an upload received every byte (for example 451, 552).
    pub stor_final_error: Option<u32>,
    pub retr_final_error: Option<u32>,
    /// Stop sending a download after this many bytes and hold the socket.
    pub stall_retr_after: Option<usize>,
    /// Bytes per second for downloads and uploads (0 = unlimited).
    pub throttle: usize,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            tls: ServerTls::None,
            tls_config: None,
            users: HashMap::from([("fixture".into(), "fixture-password".into())]),
            allow_anonymous: true,
            reject_auth_tls: false,
            reject_prot_p: false,
            require_session_reuse: false,
            mlsd: true,
            list_format: ListFormat::Unix,
            stor_final_error: None,
            retr_final_error: None,
            stall_retr_after: None,
            throttle: 0,
        }
    }
}

/// What the server observed, for assertions.
#[derive(Default)]
pub struct ServerLog {
    /// Control commands as received; a PASS argument is kept so tests can
    /// assert that no password was sent before trust was established.
    pub commands: Mutex<Vec<String>>,
    pub data_tls_resumed: Mutex<Vec<bool>>,
    pub open_controls: AtomicUsize,
    pub peak_controls: AtomicUsize,
    pub accepted_controls: AtomicUsize,
}

impl ServerLog {
    pub fn sent(&self, prefix: &str) -> bool {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .any(|command| command.starts_with(prefix))
    }
}

pub struct FtpTestServer {
    pub addr: SocketAddr,
    pub root: PathBuf,
    pub log: Arc<ServerLog>,
    stop: Arc<AtomicBool>,
}

impl FtpTestServer {
    pub fn start(root: PathBuf, options: ServerOptions) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let log = Arc::new(ServerLog::default());
        let options = Arc::new(options);
        {
            let (stop, log, root) = (Arc::clone(&stop), Arc::clone(&log), root.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = stream.set_nonblocking(false);
                            let (options, log, root, stop) = (
                                Arc::clone(&options),
                                Arc::clone(&log),
                                root.clone(),
                                Arc::clone(&stop),
                            );
                            thread::spawn(move || {
                                log.accepted_controls.fetch_add(1, Ordering::SeqCst);
                                let open = log.open_controls.fetch_add(1, Ordering::SeqCst) + 1;
                                log.peak_controls.fetch_max(open, Ordering::SeqCst);
                                let _ = Session::run(stream, &options, &log, &root, &stop);
                                log.open_controls.fetch_sub(1, Ordering::SeqCst);
                            });
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        Ok(Self {
            addr,
            root,
            log,
            stop,
        })
    }
    /// Waits until every control connection the server accepted is closed.
    pub fn wait_for_closed_controls(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.log.open_controls.load(Ordering::SeqCst) == 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

impl Drop for FtpTestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

enum Stream {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ServerConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Self::Plain(stream) => stream,
            Self::Tls(stream) => stream.get_ref(),
        }
    }
}
impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.read(buffer),
            Self::Tls(stream) => stream.read(buffer),
        }
    }
}
impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.write(buffer),
            Self::Tls(stream) => stream.write(buffer),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(stream) => stream.flush(),
            Self::Tls(stream) => stream.flush(),
        }
    }
}

fn accept_tls(config: &Arc<ServerConfig>, socket: TcpStream) -> io::Result<Stream> {
    let connection = ServerConnection::new(Arc::clone(config))
        .map_err(|error| io::Error::other(error.to_string()))?;
    let mut stream = StreamOwned::new(connection, socket);
    while stream.conn.is_handshaking() {
        stream
            .conn
            .complete_io(&mut stream.sock)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    }
    Ok(Stream::Tls(Box::new(stream)))
}

fn close(stream: Stream) {
    if let Stream::Tls(mut stream) = stream {
        stream.conn.send_close_notify();
        let _ = stream.conn.complete_io(&mut stream.sock);
        let _ = stream.sock.shutdown(Shutdown::Write);
    } else if let Stream::Plain(stream) = stream {
        let _ = stream.shutdown(Shutdown::Write);
    }
}

struct Session<'a> {
    control: Stream,
    options: &'a ServerOptions,
    log: &'a ServerLog,
    root: &'a Path,
    stop: &'a AtomicBool,
    user: Option<String>,
    logged_in: bool,
    protected: bool,
    passive: Option<TcpListener>,
    rename_from: Option<PathBuf>,
    restart: u64,
}

impl<'a> Session<'a> {
    fn run(
        socket: TcpStream,
        options: &'a ServerOptions,
        log: &'a ServerLog,
        root: &'a Path,
        stop: &'a AtomicBool,
    ) -> io::Result<()> {
        socket.set_read_timeout(Some(Duration::from_secs(60)))?;
        let control = if options.tls == ServerTls::Implicit {
            accept_tls(options.tls_config.as_ref().unwrap(), socket)?
        } else {
            Stream::Plain(socket)
        };
        let mut session = Session {
            control,
            options,
            log,
            root,
            stop,
            user: None,
            logged_in: false,
            protected: false,
            passive: None,
            rename_from: None,
            restart: 0,
        };
        session.reply(220, "Vesperwind test FTP server")?;
        while let Some(line) = session.read_line()? {
            if session.stop.load(Ordering::Acquire) {
                break;
            }
            log.commands.lock().unwrap().push(line.clone());
            let (verb, argument) = line
                .split_once(' ')
                .map(|(verb, argument)| (verb.to_ascii_uppercase(), argument.to_string()))
                .unwrap_or_else(|| (line.to_ascii_uppercase(), String::new()));
            if verb == "QUIT" {
                session.reply(221, "Bye")?;
                break;
            }
            session.command(&verb, &argument)?;
        }
        Ok(())
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        let mut bytes = vec![];
        let mut byte = [0u8];
        loop {
            match self.control.read(&mut byte) {
                Ok(0) => return Ok(None),
                Ok(_) => {
                    if byte[0] == b'\n' {
                        break;
                    }
                    bytes.push(byte[0]);
                    if bytes.len() > 8192 {
                        return Ok(None);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Ok(None),
            }
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn reply(&mut self, code: u32, text: &str) -> io::Result<()> {
        self.control
            .write_all(format!("{code} {text}\r\n").as_bytes())?;
        self.control.flush()
    }

    fn path(&self, argument: &str) -> Option<PathBuf> {
        let mut path = self.root.to_path_buf();
        for part in argument.split('/') {
            match part {
                "" | "." => {}
                ".." => return None,
                part => path.push(part),
            }
        }
        Some(path)
    }

    fn tls_required(&self) -> bool {
        self.options.tls != ServerTls::None
    }

    fn command(&mut self, verb: &str, argument: &str) -> io::Result<()> {
        let secured = matches!(self.control, Stream::Tls(_));
        match verb {
            "AUTH" => {
                if self.options.tls == ServerTls::None || self.options.reject_auth_tls {
                    return self.reply(502, "AUTH not supported");
                }
                if !argument.eq_ignore_ascii_case("TLS") {
                    return self.reply(504, "Only AUTH TLS");
                }
                self.reply(234, "Proceed with negotiation")?;
                let socket = self.control.tcp().try_clone()?;
                self.control = accept_tls(self.options.tls_config.as_ref().unwrap(), socket)?;
                Ok(())
            }
            "USER" => {
                if self.tls_required() && !secured {
                    return self.reply(530, "TLS required");
                }
                self.user = Some(argument.to_string());
                self.reply(331, "Password required")
            }
            "PASS" => {
                let Some(user) = self.user.clone() else {
                    return self.reply(503, "USER first");
                };
                let accepted = (user == "anonymous" && self.options.allow_anonymous)
                    || self.options.users.get(&user).is_some_and(|p| p == argument);
                self.logged_in = accepted;
                if accepted {
                    self.reply(230, "Logged in")
                } else {
                    self.reply(530, "Login incorrect")
                }
            }
            "PBSZ" => self.reply(200, "PBSZ=0"),
            "PROT" => {
                if argument.eq_ignore_ascii_case("P") {
                    if self.options.reject_prot_p || !secured {
                        return self.reply(536, "PROT P not available");
                    }
                    self.protected = true;
                    self.reply(200, "Protection set to Private")
                } else if self.tls_required() {
                    self.reply(534, "Clear data channel refused")
                } else {
                    self.protected = false;
                    self.reply(200, "Protection set to Clear")
                }
            }
            "FEAT" => {
                let mut features = vec!["UTF8", "SIZE", "MDTM", "REST STREAM", "EPSV"];
                if self.options.mlsd {
                    features.push("MLST type*;size*;modify*;perm*;");
                }
                if self.options.tls != ServerTls::None {
                    features.extend(["AUTH TLS", "PBSZ", "PROT"]);
                }
                let mut text = "211-Features\r\n".to_string();
                for feature in features {
                    text.push_str(&format!(" {feature}\r\n"));
                }
                text.push_str("211 End\r\n");
                self.control.write_all(text.as_bytes())?;
                self.control.flush()
            }
            "OPTS" => self.reply(200, "OK"),
            "SYST" => self.reply(215, "UNIX Type: L8"),
            "NOOP" => self.reply(200, "OK"),
            "TYPE" | "MODE" | "STRU" => self.reply(200, "OK"),
            _ if !self.logged_in => self.reply(530, "Not logged in"),
            "PWD" => self.reply(257, "\"/\" is the current directory"),
            "CWD" => match self.path(argument) {
                Some(path) if path.is_dir() => self.reply(250, "OK"),
                _ => self.reply(550, "No such directory"),
            },
            "EPSV" | "PASV" => {
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let port = listener.local_addr()?.port();
                self.passive = Some(listener);
                if verb == "EPSV" {
                    self.reply(229, &format!("Entering Extended Passive Mode (|||{port}|)"))
                } else {
                    self.reply(
                        227,
                        &format!(
                            "Entering Passive Mode (127,0,0,1,{},{})",
                            port / 256,
                            port % 256
                        ),
                    )
                }
            }
            "REST" => {
                self.restart = argument.parse().unwrap_or(0);
                self.reply(350, "Restarting")
            }
            "SIZE" => match self.path(argument).and_then(|p| fs::metadata(p).ok()) {
                Some(metadata) if metadata.is_file() => {
                    self.reply(213, &metadata.len().to_string())
                }
                _ => self.reply(550, "No such file"),
            },
            "MDTM" => match self.path(argument).and_then(|p| fs::metadata(p).ok()) {
                Some(metadata) if metadata.is_file() => {
                    self.reply(213, &timestamp(metadata.modified().ok()))
                }
                _ => self.reply(550, "No such file"),
            },
            "MLST" if self.options.mlsd => match self.path(argument) {
                Some(path) if fs::symlink_metadata(&path).is_ok() => {
                    let fact = mlsd_line(&path, argument);
                    let text = format!("250-Listing {argument}\r\n {fact}\r\n250 End\r\n");
                    self.control.write_all(text.as_bytes())?;
                    self.control.flush()
                }
                _ => self.reply(550, "No such file"),
            },
            "MLSD" | "LIST" | "NLST" => {
                if verb == "MLSD" && !self.options.mlsd {
                    return self.reply(500, "Unknown command");
                }
                let directory = if argument.starts_with('-') {
                    "/"
                } else {
                    argument
                };
                let Some(path) = self.path(directory).filter(|p| p.is_dir()) else {
                    return self.reply(550, "No such directory");
                };
                let mut names: Vec<_> = fs::read_dir(&path)?
                    .filter_map(Result::ok)
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                let lines: Vec<String> = names
                    .iter()
                    .map(|name| {
                        let child = path.join(name);
                        match verb {
                            "MLSD" => mlsd_line(&child, name),
                            "NLST" => name.clone(),
                            _ => list_line(&child, name, self.options.list_format),
                        }
                    })
                    .collect();
                let mut bytes = lines.join("\r\n").into_bytes();
                if !lines.is_empty() {
                    bytes.extend_from_slice(b"\r\n");
                }
                self.send_data(bytes, None)
            }
            "RETR" => {
                let Some(path) = self.path(argument).filter(|p| p.is_file()) else {
                    return self.reply(550, "No such file");
                };
                let mut bytes = fs::read(path)?;
                let offset = std::mem::take(&mut self.restart) as usize;
                bytes.drain(..offset.min(bytes.len()));
                self.send_data(bytes, self.options.retr_final_error)
            }
            "STOR" => {
                let Some(path) = self.path(argument) else {
                    return self.reply(553, "Bad name");
                };
                self.receive_data(&path)
            }
            "DELE" => match self.path(argument).filter(|p| p.is_file()) {
                Some(path) if fs::remove_file(&path).is_ok() => self.reply(250, "Deleted"),
                _ => self.reply(550, "Delete failed"),
            },
            "RMD" => match self.path(argument).filter(|p| p.is_dir()) {
                Some(path) if fs::remove_dir(&path).is_ok() => self.reply(250, "Removed"),
                _ => self.reply(550, "Remove failed"),
            },
            "MKD" => match self.path(argument) {
                Some(path) if fs::create_dir(&path).is_ok() => {
                    self.reply(257, &format!("\"{argument}\" created"))
                }
                _ => self.reply(550, "Create failed"),
            },
            "RNFR" => match self
                .path(argument)
                .filter(|p| fs::symlink_metadata(p).is_ok())
            {
                Some(path) => {
                    self.rename_from = Some(path);
                    self.reply(350, "Ready for RNTO")
                }
                None => self.reply(550, "No such file"),
            },
            "RNTO" => {
                let from = self.rename_from.take();
                match (from, self.path(argument)) {
                    (Some(from), Some(to)) if fs::rename(&from, &to).is_ok() => {
                        self.reply(250, "Renamed")
                    }
                    _ => self.reply(550, "Rename failed"),
                }
            }
            "ABOR" => self.reply(226, "Abort OK"),
            _ => self.reply(502, "Command not implemented"),
        }
    }

    fn open_data(&mut self) -> io::Result<Option<Stream>> {
        let Some(listener) = self.passive.take() else {
            self.reply(425, "Use EPSV or PASV first")?;
            return Ok(None);
        };
        if self.tls_required() && !self.protected {
            self.reply(521, "PROT P required")?;
            return Ok(None);
        }
        self.reply(150, "Opening data connection")?;
        listener.set_nonblocking(false)?;
        let (socket, _) = listener.accept()?;
        socket.set_read_timeout(Some(Duration::from_secs(60)))?;
        if !self.protected {
            return Ok(Some(Stream::Plain(socket)));
        }
        match accept_tls(self.options.tls_config.as_ref().unwrap(), socket) {
            Ok(stream) => {
                let resumed = matches!(&stream, Stream::Tls(tls)
                    if tls.conn.handshake_kind() == Some(rustls::HandshakeKind::Resumed));
                self.log.data_tls_resumed.lock().unwrap().push(resumed);
                if self.options.require_session_reuse && !resumed {
                    close(stream);
                    self.reply(522, "SSL connection failed: session reuse required")?;
                    return Ok(None);
                }
                Ok(Some(stream))
            }
            Err(_) => {
                self.reply(425, "TLS negotiation on the data connection failed")?;
                Ok(None)
            }
        }
    }

    fn pace(&self, sent: usize) {
        if self.options.throttle > 0 {
            thread::sleep(Duration::from_secs_f64(
                sent as f64 / self.options.throttle as f64,
            ));
        }
    }

    fn send_data(&mut self, bytes: Vec<u8>, final_error: Option<u32>) -> io::Result<()> {
        let Some(mut data) = self.open_data()? else {
            return Ok(());
        };
        let chunk = if self.options.throttle > 0 {
            (self.options.throttle / 10).max(1)
        } else {
            64 * 1024
        };
        let mut sent = 0;
        for part in bytes.chunks(chunk) {
            if self
                .options
                .stall_retr_after
                .is_some_and(|limit| sent >= limit)
            {
                // Hold the data connection without sending, until the client
                // gives up or the server stops.
                while !self.stop.load(Ordering::Acquire) {
                    let mut probe = [0u8; 1];
                    let _ = data.tcp().set_read_timeout(Some(Duration::from_millis(50)));
                    match data.tcp().peek(&mut probe) {
                        Ok(0) => return Ok(()),
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                            ) => {}
                        _ => return Ok(()),
                    }
                }
                return Ok(());
            }
            if data.write_all(part).is_err() {
                return self.reply(426, "Connection closed; transfer aborted");
            }
            sent += part.len();
            self.pace(part.len());
        }
        close(data);
        match final_error {
            Some(code) => self.reply(code, "Transfer failed after sending data"),
            None => self.reply(226, "Transfer complete"),
        }
    }

    fn receive_data(&mut self, path: &Path) -> io::Result<()> {
        let Some(mut data) = self.open_data()? else {
            return Ok(());
        };
        let mut file = fs::File::create(path)?;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match data.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    file.write_all(&buffer[..read])?;
                    self.pace(read);
                }
                // A peer that closes without close_notify still delivered its bytes.
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(_) => return self.reply(426, "Connection closed; transfer aborted"),
            }
        }
        drop(data);
        match self.options.stor_final_error {
            Some(code) => self.reply(code, "Upload rejected after receiving data"),
            None => self.reply(226, "Transfer complete"),
        }
    }
}

fn timestamp(time: Option<SystemTime>) -> String {
    let seconds = time
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .format("%Y%m%d%H%M%S")
        .to_string()
}

fn mlsd_line(path: &Path, name: &str) -> String {
    let metadata = fs::symlink_metadata(path);
    let modified = timestamp(metadata.as_ref().ok().and_then(|m| m.modified().ok()));
    match metadata {
        Ok(m) if m.file_type().is_symlink() => format!(
            "type=OS.unix=slink:{};modify={modified}; {name}",
            fs::read_link(path)
                .map(|t| t.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
        Ok(m) if m.is_dir() => format!("type=dir;modify={modified};perm=flcdmpe; {name}"),
        Ok(m) => format!(
            "type=file;size={};modify={modified};perm=adfrw; {name}",
            m.len()
        ),
        Err(_) => format!("type=file; {name}"),
    }
}

fn list_line(path: &Path, name: &str, format: ListFormat) -> String {
    let metadata = fs::symlink_metadata(path).ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let is_dir = metadata.as_ref().is_some_and(|m| m.is_dir());
    let is_link = metadata
        .as_ref()
        .is_some_and(|m| m.file_type().is_symlink());
    match format {
        ListFormat::Dos => {
            if is_dir {
                format!("01-02-26  03:04PM       <DIR>          {name}")
            } else {
                format!("01-02-26  03:04PM       {size:>14} {name}")
            }
        }
        ListFormat::Unix => {
            let kind = if is_link {
                'l'
            } else if is_dir {
                'd'
            } else {
                '-'
            };
            let target = if is_link {
                format!(
                    " -> {}",
                    fs::read_link(path)
                        .map(|t| t.to_string_lossy().into_owned())
                        .unwrap_or_default()
                )
            } else {
                String::new()
            };
            format!("{kind}rw-r--r--    1 owner    group    {size:>10} Jan 02 15:04 {name}{target}")
        }
    }
}

pub fn tls_config(
    certificates: Vec<CertificateDer<'static>>,
    key: rustls::pki_types::PrivateKeyDer<'static>,
) -> io::Result<Arc<ServerConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| io::Error::other(e.to_string()))?
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .map_err(|e| io::Error::other(e.to_string()))?;
    Ok(Arc::new(config))
}
