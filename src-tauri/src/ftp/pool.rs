//! The sessions of one connected FTP/FTPS profile.
//!
//! An FTP control connection serves one command or data transfer at a time,
//! so each operation leases its own session. At most `MAX_SESSIONS` exist per
//! profile; further requests wait. A session goes back to the pool only after
//! its protocol operation finished successfully. Anything else (a lost
//! connection, an aborted or failed transfer) discards it, so a damaged
//! session is never reused. Keepalive `NOOP`s are only sent on idle sessions.
use super::connection::{
    finish_download, finish_upload, ConnectFailure, ConnectSpec, DataTransfer, FtpSession, Security,
};
use crate::{
    connections::ConnectionProfile,
    credential_store::{CredentialKind, CredentialStore},
    error::NativeError,
};
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use zeroize::Zeroizing;

/// One session for browsing plus three for independent transfers.
pub const MAX_SESSIONS: usize = 4;
/// How long an operation waits for a free session before reporting EFTP_BUSY.
const LEASE_WAIT: Duration = Duration::from_secs(120);

/// The password source of a connected profile. A typed password stays in
/// zeroizing memory for the session; a saved one is read from the
/// CredentialStore of this exact profile (protocol and id) when needed.
pub struct Credentials {
    pub transient: Zeroizing<String>,
    pub store: Option<Arc<CredentialStore>>,
}

impl Credentials {
    pub fn password(&self, profile: &ConnectionProfile) -> Result<Zeroizing<String>, NativeError> {
        if profile.auth_type == "anonymous" {
            return Ok(Zeroizing::new("anonymous@".into()));
        }
        if !self.transient.is_empty() {
            return Ok(self.transient.clone());
        }
        if profile.save_password {
            if let Some(saved) = self
                .store
                .as_ref()
                .map(|store| store.get(profile, CredentialKind::Password))
                .transpose()?
                .flatten()
            {
                return Ok(saved);
            }
        }
        Err(NativeError::new(
            "EAUTHENTICATION_REQUIRED",
            "Enter the password for this FTP connection",
        ))
    }
}

pub fn security(profile: &ConnectionProfile) -> Security {
    match (profile.protocol.as_str(), profile.ftp_tls.as_str()) {
        ("ftps", "implicit") => Security::Implicit,
        ("ftps", _) => Security::Explicit,
        _ => Security::Plain,
    }
}

pub struct FtpConnection {
    pub profile: ConnectionProfile,
    pub credentials: Credentials,
    pub root: String,
    pub initial: String,
    pub home: String,
    pub extra_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
    connected: AtomicBool,
    idle: Mutex<Vec<FtpSession>>,
    open: Mutex<usize>,
    available: Condvar,
}

impl FtpConnection {
    pub fn new(
        profile: ConnectionProfile,
        credentials: Credentials,
        first: FtpSession,
        paths: (String, String, String),
        extra_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            profile,
            credentials,
            root: paths.0,
            initial: paths.1,
            home: paths.2,
            extra_roots,
            connected: AtomicBool::new(true),
            idle: Mutex::new(vec![first]),
            open: Mutex::new(1),
            available: Condvar::new(),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub fn spec(&self) -> Result<ConnectSpec, NativeError> {
        Ok(ConnectSpec {
            host: self.profile.host.clone(),
            port: self.profile.port,
            security: security(&self.profile),
            username: self.profile.username.clone(),
            password: self.credentials.password(&self.profile)?,
            pin: Some(self.profile.tls_trusted_certificate.clone()).filter(|pin| !pin.is_empty()),
            extra_roots: self.extra_roots.clone(),
        })
    }

    /// Takes an idle session, opens a new one within the limit, or waits.
    pub fn lease(self: &Arc<Self>) -> Result<Lease, NativeError> {
        let deadline = std::time::Instant::now() + LEASE_WAIT;
        loop {
            if !self.is_connected() {
                return Err(disconnected());
            }
            if let Some(session) = self.idle.lock().unwrap_or_else(|e| e.into_inner()).pop() {
                return Ok(Lease::new(self, session));
            }
            let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
            if *open < MAX_SESSIONS {
                *open += 1;
                drop(open);
                let session = self.spec().and_then(|spec| {
                    FtpSession::connect(&spec).map_err(|failure: ConnectFailure| failure.error)
                });
                return match session {
                    Ok(session) => Ok(Lease::new(self, session)),
                    Err(error) => {
                        self.forget_session();
                        Err(error)
                    }
                };
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(NativeError::new(
                    "EFTP_BUSY",
                    "All FTP connections of this server are busy",
                ));
            }
            let (guard, _) = self
                .available
                .wait_timeout(open, (deadline - now).min(Duration::from_millis(250)))
                .unwrap_or_else(|e| e.into_inner());
            drop(guard);
        }
    }

    fn forget_session(&self) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        *open = open.saturating_sub(1);
        self.available.notify_all();
    }

    fn return_session(&self, session: FtpSession) {
        if self.is_connected() {
            self.idle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(session);
            self.available.notify_all();
        } else {
            session.quit();
            self.forget_session();
        }
    }

    /// Ends every idle session; leased ones are closed when they come back.
    pub fn close(&self) {
        self.connected.store(false, Ordering::Release);
        let sessions: Vec<_> = self
            .idle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect();
        for session in sessions {
            session.quit();
            self.forget_session();
        }
        self.available.notify_all();
    }

    /// Sends NOOP on idle sessions only and drops the ones that fail.
    pub fn keepalive(&self) {
        let sessions: Vec<_> = self
            .idle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect();
        for mut session in sessions {
            if session.noop().is_ok() {
                self.return_session(session);
            } else {
                session.sever();
                self.forget_session();
            }
        }
    }

    /// Breaks every idle session's control connection, as a server-side
    /// timeout would.
    #[cfg(test)]
    pub fn sever_idle(&self) {
        for session in self.idle.lock().unwrap().iter() {
            session.sever();
        }
    }
    #[cfg(test)]
    pub fn open_sessions(&self) -> usize {
        *self.open.lock().unwrap()
    }
    #[cfg(test)]
    pub fn idle_sessions(&self) -> usize {
        self.idle.lock().unwrap().len()
    }

    /// Runs an operation whose repetition is harmless (listing, reading
    /// metadata). A session that lost its connection, for example after the
    /// server's idle timeout, is replaced and the operation repeated once.
    pub fn repeatable<T>(
        self: &Arc<Self>,
        mut operation: impl FnMut(&mut FtpSession) -> Result<T, (NativeError, bool)>,
    ) -> Result<T, NativeError> {
        for attempt in 0..2 {
            let mut lease = self.lease()?;
            match operation(lease.session()) {
                Ok(value) => {
                    lease.release();
                    return Ok(value);
                }
                Err((error, lost)) => {
                    if lost {
                        lease.discard();
                        if attempt == 0 {
                            // Idle sessions are probably stale as well (server
                            // restart, idle timeout); retry on a new one.
                            self.discard_idle();
                            continue;
                        }
                    } else {
                        lease.release();
                    }
                    return Err(error);
                }
            }
        }
        unreachable!()
    }

    fn discard_idle(&self) {
        let sessions: Vec<_> = self
            .idle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect();
        for session in sessions {
            session.sever();
            self.forget_session();
        }
    }

    /// Runs a changing operation exactly once. After a lost connection the
    /// outcome is unknown (the server may have applied it), so it is reported
    /// and never repeated.
    pub fn once<T>(
        self: &Arc<Self>,
        operation: impl FnOnce(&mut FtpSession) -> Result<T, NativeError>,
    ) -> Result<T, NativeError> {
        let mut lease = self.lease()?;
        match operation(lease.session()) {
            Ok(value) => {
                lease.release();
                Ok(value)
            }
            Err(error) => {
                if is_lost(&error) {
                    lease.discard();
                } else {
                    lease.release();
                }
                Err(error)
            }
        }
    }

    pub fn download(self: &Arc<Self>, path: &str) -> Result<FtpReader, NativeError> {
        for attempt in 0..2 {
            let mut lease = self.lease()?;
            match lease.session().retrieve(path) {
                Ok(transfer) => {
                    return Ok(FtpReader {
                        lease: Some(lease),
                        transfer: Some(transfer),
                        path: path.to_string(),
                        finished: None,
                        at_end: false,
                        complete_at_end: false,
                    })
                }
                Err((error, lost)) => {
                    if lost {
                        lease.discard();
                        if attempt == 0 {
                            self.discard_idle();
                            continue;
                        }
                    } else {
                        lease.release();
                    }
                    return Err(error);
                }
            }
        }
        unreachable!()
    }

    /// Opens an upload. FTP has no atomic create-new: the caller checks for
    /// an existing item first, and a race with another client remains.
    pub fn upload(self: &Arc<Self>, path: &str) -> Result<FtpWriter, NativeError> {
        let mut lease = self.lease()?;
        match lease.session().store(path) {
            Ok(transfer) => Ok(FtpWriter {
                lease: Some(lease),
                transfer: Some(transfer),
                path: path.to_string(),
            }),
            Err((error, lost)) => {
                if lost {
                    lease.discard();
                } else {
                    lease.release();
                }
                Err(error)
            }
        }
    }
}

pub fn disconnected() -> NativeError {
    NativeError::new("EFTP_DISCONNECTED", "The FTP connection is disconnected")
}

pub fn is_lost(error: &NativeError) -> bool {
    matches!(
        error.code.as_str(),
        "EFTP_DISCONNECTED" | "ETIMEDOUT" | "ETLS" | "EFTP_TRANSFER"
    )
}

/// A leased session. `release` returns it to the pool; dropping it without
/// release discards it.
pub struct Lease {
    connection: Arc<FtpConnection>,
    session: Option<FtpSession>,
}

impl Lease {
    fn new(connection: &Arc<FtpConnection>, session: FtpSession) -> Self {
        Self {
            connection: Arc::clone(connection),
            session: Some(session),
        }
    }
    pub fn session(&mut self) -> &mut FtpSession {
        self.session.as_mut().expect("leased session")
    }
    pub fn release(mut self) {
        if let Some(session) = self.session.take() {
            self.connection.return_session(session);
        }
    }
    pub fn discard(mut self) {
        if let Some(session) = self.session.take() {
            session.sever();
            self.connection.forget_session();
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            session.sever();
            self.connection.forget_session();
        }
    }
}

/// A download. End-of-file finishes the transfer and checks the server's
/// final reply; a failure there is a read error, never a clean end.
pub struct FtpReader {
    lease: Option<Lease>,
    transfer: Option<DataTransfer>,
    path: String,
    finished: Option<Result<(), NativeError>>,
    at_end: bool,
    /// For plain `Read` consumers that never call `finish`: complete the
    /// transfer at end-of-file and turn a failed final reply into a read error.
    complete_at_end: bool,
}

impl FtpReader {
    fn complete(&mut self) -> Result<(), NativeError> {
        if let Some(result) = &self.finished {
            return result.clone();
        }
        let result = match self.transfer.take() {
            Some(transfer) => finish_download(transfer, &self.path),
            None => Ok(()),
        };
        if let Some(lease) = self.lease.take() {
            if result.is_ok() {
                lease.release();
            } else {
                lease.discard();
            }
        }
        self.finished = Some(result.clone());
        result
    }

    pub fn complete_at_end(mut self) -> Self {
        self.complete_at_end = true;
        self
    }

    pub fn finish(mut self) -> Result<(), NativeError> {
        if self.finished.is_none() && !self.at_end && self.transfer.is_some() {
            // The caller stopped before end-of-file: this is an abort.
            self.abort();
            return Err(NativeError::new(
                "EFTP_TRANSFER",
                "The FTP download was not read to the end",
            )
            .with_path(&self.path));
        }
        self.complete()
    }

    fn abort(&mut self) {
        if let Some(lease) = self.lease.as_mut() {
            lease.session().sever();
        }
        drop(self.transfer.take());
        if let Some(lease) = self.lease.take() {
            lease.discard();
        }
        self.finished = Some(Err(NativeError::new(
            "ECANCELLED",
            "The FTP download was aborted",
        )));
    }
}

impl Read for FtpReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if let Some(result) = &self.finished {
            return match result {
                Ok(()) => Ok(0),
                Err(error) => Err(io::Error::other(error.message.clone())),
            };
        }
        let read = match self.transfer.as_mut() {
            Some(transfer) => transfer.read(buffer),
            None => Ok(0),
        };
        match read {
            Ok(0) => {
                self.at_end = true;
                if !self.complete_at_end {
                    return Ok(0);
                }
                match self.complete() {
                    Ok(()) => Ok(0),
                    Err(error) => Err(io::Error::other(error.message)),
                }
            }
            Ok(read) => Ok(read),
            Err(error) => {
                self.abort();
                Err(error)
            }
        }
    }
}

impl Drop for FtpReader {
    fn drop(&mut self) {
        if self.finished.is_none() {
            // Not completed through `finish`: never a successful transfer.
            self.abort();
        }
    }
}

/// An upload. Success is reported only by `finish`, after the data
/// connection is closed and the server confirmed the transfer.
pub struct FtpWriter {
    lease: Option<Lease>,
    transfer: Option<DataTransfer>,
    path: String,
}

impl FtpWriter {
    pub fn finish(mut self) -> Result<(), NativeError> {
        let Some(transfer) = self.transfer.take() else {
            return Err(NativeError::new(
                "EFTP_TRANSFER",
                "The FTP upload was aborted",
            ));
        };
        let result = finish_upload(transfer, &self.path);
        if let Some(lease) = self.lease.take() {
            match &result {
                Ok(()) => lease.release(),
                // A rejected final reply leaves the control connection usable,
                // but a failed close may not; never reuse a doubtful session.
                Err(_) => lease.discard(),
            }
        }
        result
    }

    pub fn abort(mut self) {
        self.abort_now();
    }

    fn abort_now(&mut self) {
        if let Some(lease) = self.lease.as_mut() {
            lease.session().sever();
        }
        drop(self.transfer.take());
        if let Some(lease) = self.lease.take() {
            lease.discard();
        }
    }
}

impl Write for FtpWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self.transfer.as_mut() {
            Some(transfer) => transfer.write(buffer),
            None => Err(io::Error::other("The FTP upload was aborted")),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.transfer.as_mut() {
            Some(transfer) => transfer.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for FtpWriter {
    fn drop(&mut self) {
        // Dropping without finish is an abort, never a successful upload.
        if self.transfer.is_some() {
            self.abort_now();
        }
    }
}
