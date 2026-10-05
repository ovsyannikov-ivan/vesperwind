//! Serialized, lazy Office conversion. The interactive WebView never loads LOWA.
mod origin;
use crate::{error::NativeError, filesystem::jobs::OperationJobs};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// One production idle policy. No engine, server, or timer exists at startup.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
pub const CONVERSION_TIMEOUT_MS: u64 = 90_000;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub build_id: String,
    pub init_ms: f64,
    pub conversion_ms: f64,
}
pub(super) struct Job {
    pub id: String,
    pub format: String,
    pub input: Vec<u8>,
    pub result: Option<Result<Vec<u8>, NativeError>>,
}
pub(super) struct SessionState {
    #[cfg(debug_assertions)]
    pub network_blocked: Option<bool>,
    pub job: Option<Job>,
    pub init_ms: f64,
    pub fatal: Option<String>,
}
pub(super) struct Session {
    pub app: AppHandle,
    pub endpoint: Arc<origin::OriginState>,
    pub build_id: String,
}
impl std::ops::Deref for Session {
    type Target = origin::OriginState;
    fn deref(&self) -> &Self::Target {
        &self.endpoint
    }
}

impl Session {
    fn label(&self) -> String {
        format!("office-converter-{}", self.generation)
    }
    fn destroy(&self) -> Result<(), NativeError> {
        self.closed.store(true, Ordering::Release);
        self.changed.notify_all();
        let (tx, rx) = std::sync::mpsc::channel();
        let app = self.app.clone();
        let label = self.label();
        self.app
            .run_on_main_thread(move || {
                let result = app
                    .get_webview_window(&label)
                    .map(|view| view.destroy())
                    .transpose();
                let _ = tx.send(result.map(|_| ()).map_err(|e| e.to_string()));
            })
            .map_err(|e| NativeError::new("ECONVERTER_DESTROY", e.to_string()))?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                NativeError::new("ECONVERTER_DESTROY", "Converter teardown did not complete")
            })?
            .map_err(|e| NativeError::new("ECONVERTER_DESTROY", e))
    }
}
struct BrokerState {
    session: Option<Arc<Session>>,
    last_used: Instant,
    teardown_error: Option<NativeError>,
}
pub struct ConversionBroker {
    gate: Mutex<()>,
    state: Mutex<BrokerState>,
    sequence: AtomicU64,
    pub jobs: OperationJobs,
    shutdown: AtomicBool,
    idle_started: AtomicBool,
}
impl Default for ConversionBroker {
    fn default() -> Self {
        Self {
            gate: Mutex::new(()),
            state: Mutex::new(BrokerState {
                session: None,
                last_used: Instant::now(),
                teardown_error: None,
            }),
            sequence: AtomicU64::new(0),
            jobs: OperationJobs::default(),
            shutdown: AtomicBool::new(false),
            idle_started: AtomicBool::new(false),
        }
    }
}
impl ConversionBroker {
    #[cfg(debug_assertions)]
    pub(crate) fn snapshot(&self) -> Option<(u64, String)> {
        self.state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .map(|s| (s.generation, s.origin.clone()))
    }
    /// Exercise CSP from the actual converter WebView against an owned
    /// different-origin sentinel. Never contact a public network endpoint.
    #[cfg(debug_assertions)]
    pub(crate) fn verify_network_isolation(&self) -> Result<(), NativeError> {
        let session = self
            .state
            .lock()
            .unwrap()
            .session
            .clone()
            .ok_or_else(|| NativeError::new("ETEST", "No converter"))?;
        let sentinel = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        sentinel.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", sentinel.local_addr().unwrap());
        let receipt = format!(
            "{}/{}/{}/security-probe",
            session.origin, session.token, session.generation
        );
        let script = format!("fetch('{url}', {{mode:'no-cors'}}).then(()=>fetch('{receipt}',{{method:'POST',body:'allowed'}}),()=>fetch('{receipt}',{{method:'POST',body:'blocked'}}));");
        let app = session.app.clone();
        let label = session.label();
        session
            .app
            .run_on_main_thread(move || {
                if let Some(view) = app.get_webview_window(&label) {
                    let _ = view.eval(&script);
                }
            })
            .map_err(|e| NativeError::new("ETEST", e.to_string()))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if sentinel.accept().is_ok() {
                return Err(NativeError::new(
                    "ETEST",
                    "Converter reached another network origin",
                ));
            }
            if let Some(blocked) = session.state.lock().unwrap().network_blocked {
                return if blocked {
                    Ok(())
                } else {
                    Err(NativeError::new(
                        "ETEST",
                        "Converter external fetch was allowed",
                    ))
                };
            }
            if Instant::now() >= deadline {
                return Err(NativeError::new(
                    "ETEST",
                    "Network isolation probe did not finish",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn cancel(&self, id: &str) {
        self.jobs.cancel(id);
    }
    fn retire(&self) -> Result<(), NativeError> {
        let session = self.state.lock().unwrap().session.take();
        if let Some(session) = session {
            if let Err(error) = session.destroy() {
                // Never construct a replacement if destruction is unconfirmed.
                self.state.lock().unwrap().teardown_error = Some(error.clone());
                return Err(error);
            }
            eprintln!("LOWA generation {} destroyed", session.generation);
        }
        Ok(())
    }
    fn start_idle(self: &Arc<Self>) {
        if self.idle_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let Some(broker) = weak.upgrade() else {
                break;
            };
            if broker.shutdown.load(Ordering::Acquire) {
                break;
            }
            let Ok(_gate) = broker.gate.try_lock() else {
                continue;
            };
            let should_retire = {
                let state = broker.state.lock().unwrap();
                state.session.is_some() && state.last_used.elapsed() >= IDLE_TIMEOUT
            };
            if should_retire {
                let _ = broker.retire();
            }
        });
    }
    fn create(&self, app: &AppHandle) -> Result<Arc<Session>, NativeError> {
        let bundled = app
            .path()
            .resource_dir()
            .map_err(|e| NativeError::new("ECONVERTER_ASSETS", e.to_string()))?
            .join("vendor/lowa");
        let assets = if cfg!(debug_assertions) && !bundled.join("ASSETS.json").exists() {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/lowa")
        } else {
            bundled
        };
        let build_id = origin::verify_assets(&assets)?;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| NativeError::from_io(&e, "Unable to create private converter origin"))?;
        let endpoint = Arc::new(origin::OriginState {
            generation: self.sequence.fetch_add(1, Ordering::AcqRel) + 1,
            token: uuid::Uuid::new_v4().simple().to_string(),
            origin: format!("http://{}", listener.local_addr().unwrap()),
            assets,
            state: Mutex::new(SessionState {
                #[cfg(debug_assertions)]
                network_blocked: None,
                job: None,
                init_ms: 0.0,
                fatal: None,
            }),
            changed: Condvar::new(),
            closed: AtomicBool::new(false),
            clients: AtomicU64::new(0),
        });
        origin::serve(listener, Arc::clone(&endpoint))?;
        let session = Arc::new(Session {
            app: app.clone(),
            endpoint,
            build_id,
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let view = Arc::clone(&session);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let url = format!("/{}/{}/", view.token, view.generation);
            let allowed = format!("{}{url}", view.origin);
            let result = WebviewWindowBuilder::new(
                &handle,
                view.label(),
                WebviewUrl::External(allowed.parse().unwrap()),
            )
            .title("Office converter")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .incognito(true)
            .inner_size(960.0, 540.0)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .on_navigation(move |url| url.as_str() == allowed)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string());
            if view.closed.load(Ordering::Acquire) {
                if let Some(window) = handle.get_webview_window(&view.label()) {
                    let _ = window.destroy();
                }
            }
            let _ = tx.send(result);
        })
        .map_err(|e| NativeError::new("ECONVERTER", e.to_string()))?;
        let result = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| NativeError::new("ECONVERTER", "Unable to create converter WebView"))
            .and_then(|r| r.map_err(|e| NativeError::new("ECONVERTER", e)));
        if let Err(e) = result {
            if let Err(teardown) = session.destroy() {
                self.state.lock().unwrap().teardown_error = Some(teardown);
            }
            return Err(e);
        }
        eprintln!(
            "LOWA generation {} created, build {}",
            session.generation, session.build_id
        );
        Ok(session)
    }
    pub fn convert(
        self: &Arc<Self>,
        app: AppHandle,
        id: String,
        bytes: Vec<u8>,
        format: String,
        timeout_ms: u64,
    ) -> Result<Output, NativeError> {
        if let Err(error) = validate(&bytes, &format) {
            self.jobs.finish(&id);
            return Err(error);
        }
        let cancel = self.jobs.register(&id);
        let deadline =
            Instant::now() + Duration::from_millis(timeout_ms.clamp(1, CONVERSION_TIMEOUT_MS));
        let terminal = || {
            if cancel.load(Ordering::Acquire) || self.shutdown.load(Ordering::Acquire) {
                Some(NativeError::new(
                    "ECANCELLED",
                    "Office conversion was cancelled",
                ))
            } else if Instant::now() >= deadline {
                Some(NativeError::new("ETIMEDOUT", "Office conversion timed out"))
            } else {
                None
            }
        };
        let result = (|| {
            let _gate = loop {
                if let Some(error) = terminal() {
                    return Err(error);
                }
                if let Ok(gate) = self.gate.try_lock() {
                    break gate;
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            let existing = {
                let state = self.state.lock().unwrap();
                if let Some(error) = &state.teardown_error {
                    return Err(error.clone());
                }
                state.session.clone()
            };
            let session = if let Some(session) = existing {
                session
            } else {
                let session = self.create(&app)?;
                self.state.lock().unwrap().session = Some(Arc::clone(&session));
                self.start_idle();
                session
            };
            let started = Instant::now();
            {
                session.state.lock().unwrap().job = Some(Job {
                    id: id.clone(),
                    format,
                    input: bytes,
                    result: None,
                });
                session.changed.notify_all();
            }
            loop {
                if let Some(error) = terminal() {
                    self.retire()?;
                    return Err(error);
                }
                if session.closed.load(Ordering::Acquire) {
                    self.retire()?;
                    return Err(NativeError::new(
                        "EWORKER_LOST",
                        "The Office converter stopped",
                    ));
                }
                let mut state = session.state.lock().unwrap();
                if let Some(error) = state.fatal.take() {
                    drop(state);
                    self.retire()?;
                    return Err(NativeError::new("EWORKER_LOST", error));
                }
                if let Some(result) = state.job.as_mut().and_then(|job| job.result.take()) {
                    let init_ms = state.init_ms;
                    state.job = None;
                    drop(state);
                    self.state.lock().unwrap().last_used = Instant::now();
                    // Failed UNO state is discarded; the next request starts cleanly.
                    if result.is_err() {
                        self.retire()?;
                    }
                    let output = result?;
                    eprintln!(
                        "LOWA conversion {}: {:.0} ms, init {:.0} ms",
                        id,
                        started.elapsed().as_secs_f64() * 1000.0,
                        init_ms
                    );
                    return Ok(Output {
                        bytes: output,
                        build_id: session.build_id.clone(),
                        init_ms,
                        conversion_ms: started.elapsed().as_secs_f64() * 1000.0,
                    });
                }
                let _ = session
                    .changed
                    .wait_timeout(state, Duration::from_millis(50))
                    .unwrap();
            }
        })();
        self.jobs.finish(&id);
        result
    }
    /// RunEvent shutdown is on the UI thread; destroy directly, without waiting on it.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.jobs.shutdown();
        if let Some(session) = self.state.lock().unwrap().session.take() {
            session.closed.store(true, Ordering::Release);
            session.changed.notify_all();
            if let Some(view) = session.app.get_webview_window(&session.label()) {
                let _ = view.destroy();
            }
        }
    }
}
fn validate(bytes: &[u8], format: &str) -> Result<(), NativeError> {
    if !matches!(format, "pptx" | "doc" | "rtf") {
        return Err(NativeError::new(
            "EINVAL",
            "Only PPTX, DOC and RTF can be converted",
        ));
    }
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Office conversion accepts non-empty files up to 64 MiB",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_has_no_engine_or_origin() {
        let broker = ConversionBroker::default();
        assert!(broker.state.lock().unwrap().session.is_none());
        assert!(!broker.idle_started.load(Ordering::Acquire));
    }
    #[test]
    fn unsupported_input_never_initializes_engine() {
        assert_eq!(validate(b"data", "xls").unwrap_err().code, "EINVAL");
    }
}
