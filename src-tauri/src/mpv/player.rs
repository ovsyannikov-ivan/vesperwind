use super::{
    hdr_policy::{dxgi_format, WindowsOutputPolicy},
    presentation::{Backend, Presentation},
    stream::MpvStreamRegistry,
    surface::{DisplayCapabilities, NativeSurface},
    MpvApi, MpvHandle, MPV_EVENT_END_FILE, MPV_EVENT_FILE_LOADED, MPV_EVENT_NONE,
    MPV_EVENT_SHUTDOWN,
};
use crate::{filesystem::Filesystem, provider_content::ContentSource, ssh::SshManager};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Window};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_scale")]
    pub scale_factor: f64,
    #[serde(default)]
    #[cfg(target_os = "macos")]
    pub viewport_height: Option<f64>,
    #[serde(default)]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub border_radius: f64,
    #[serde(default = "default_subtitle_position")]
    pub subtitle_position: f64,
}

fn default_scale() -> f64 {
    1.0
}

fn default_subtitle_position() -> f64 {
    100.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerTrack {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub language: Option<String>,
    pub codec: Option<String>,
    pub friendly_codec: Option<String>,
    pub selected: bool,
    pub default: bool,
    pub forced: bool,
    pub external: bool,
    pub channels: Option<String>,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<i64>,
    pub friendly_language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub presentation: super::render::FramePresentation,
    pub status: String,
    pub current_time: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub subtitle_delay: f64,
    pub tracks: Vec<PlayerTrack>,
    pub diagnostics: PlaybackDiagnostics,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackDiagnostics {
    pub presentation_fallback_reason: Option<String>,
    pub container: Option<String>,
    pub friendly_container: Option<String>,
    pub file_size: Option<i64>,
    pub duration: Option<f64>,
    pub overall_bitrate: Option<f64>,
    pub video: VideoDiagnostics,
    pub audio: AudioDiagnostics,
    pub subtitle: SubtitleDiagnostics,
    pub source_hdr: bool,
    pub source_format: Option<String>,
    pub transfer: Option<String>,
    pub friendly_transfer: Option<String>,
    pub primaries: Option<String>,
    pub friendly_primaries: Option<String>,
    pub pixel_format: Option<String>,
    pub source_pixel_format: Option<String>,
    pub bit_depth: Option<u32>,
    pub max_luminance_nits: Option<f64>,
    pub max_cll_nits: Option<f64>,
    pub max_fall_nits: Option<f64>,
    pub dolby_vision_profile: Option<i64>,
    pub dolby_vision_level: Option<i64>,
    pub dolby_vision_support: Option<String>,
    pub output_hdr_active: bool,
    pub output_mode: String,
    pub output_color_space: String,
    pub tone_mapping: String,
    pub target_peak_nits: Option<f64>,
    pub fallback_reason: Option<String>,
    pub decoder: Option<String>,
    pub hardware_decoder: Option<String>,
    pub renderer: String,
    pub display: DisplayCapabilities,
    pub windows_output: Option<WindowsOutputDiagnostics>,
    pub dropped_frames: Option<i64>,
    pub decoder_dropped_frames: Option<i64>,
    pub delayed_frames: Option<i64>,
    pub video_sync: Option<String>,
    pub av_sync_seconds: Option<f64>,
    pub source_hdr_metadata: HdrMetadataDiagnostics,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HdrMetadataDiagnostics {
    pub min_luminance_nits: Option<f64>,
    pub max_luminance_nits: Option<f64>,
    pub max_cll_nits: Option<f64>,
    pub max_fall_nits: Option<f64>,
    // Available only when mpv exposes all chromaticity coordinates; never
    // substitute BT.2020 for missing mastering-display primaries.
    pub mastering_primaries: Option<[f64; 8]>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsOutputDiagnostics {
    pub requested: String,
    pub requested_transfer: Option<String>,
    pub requested_primaries: Option<String>,
    pub target_verified: bool,
    pub target_transfer: Option<String>,
    pub target_primaries: Option<String>,
    pub target_pixel_format: Option<String>,
    pub dxgi_format: Option<String>,
    pub format_evidence: String,
    pub expected_dxgi_color_space: Option<String>,
    pub color_space_evidence: String,
    pub hdr_metadata_state: String,
    pub target_hdr_metadata: HdrMetadataDiagnostics,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDiagnostics {
    pub codec: Option<String>,
    pub friendly_codec: Option<String>,
    pub profile: Option<String>,
    pub level: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frame_rate: Option<f64>,
    pub progressive: Option<bool>,
    pub bitrate: Option<f64>,
    pub chroma: Option<String>,
    pub matrix: Option<String>,
    pub friendly_matrix: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub codec: Option<String>,
    pub friendly_codec: Option<String>,
    pub bitrate: Option<f64>,
    pub channel_layout: Option<String>,
    pub channel_count: Option<i64>,
    pub sample_rate: Option<i64>,
    pub language: Option<String>,
    pub friendly_language: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleDiagnostics {
    pub format: Option<String>,
    pub friendly_format: Option<String>,
    pub language: Option<String>,
    pub friendly_language: Option<String>,
    pub title: Option<String>,
    pub default: Option<bool>,
    pub forced: Option<bool>,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
            presentation: Default::default(),
            status: "idle".to_string(),
            current_time: 0.0,
            duration: 0.0,
            volume: 1.0,
            muted: false,
            subtitle_delay: 0.0,
            tracks: Vec::new(),
            diagnostics: PlaybackDiagnostics::default(),
            error: None,
        }
    }
}

enum Control {
    Load {
        uri: String,
        autoplay: bool,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    Play(mpsc::SyncSender<Result<PlayerSnapshot, String>>),
    Pause(mpsc::SyncSender<Result<PlayerSnapshot, String>>),
    Seek {
        seconds: f64,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    SetVolume {
        volume: f64,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    SetMuted {
        muted: bool,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    SelectTrack {
        kind: String,
        id: Option<i64>,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    SetSubtitleDelay {
        seconds: f64,
        reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    },
    SetSubtitlePosition(f64),
    Snapshot(mpsc::SyncSender<Result<PlayerSnapshot, String>>),
    Shutdown(mpsc::SyncSender<()>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlayerLifecycle {
    Opening,
    Ready,
    Playing,
    Paused,
    Closing,
    Error,
    Closed,
}

impl PlayerLifecycle {
    fn accepts_commands(self) -> bool {
        matches!(self, Self::Ready | Self::Playing | Self::Paused)
    }
}

fn is_target_session(active: Option<&str>, requested: &str) -> bool {
    active == Some(requested)
}

struct RunningPlayer {
    session_id: String,
    sender: mpsc::Sender<Control>,
    surface: NativeSurface,
    thread: Option<JoinHandle<()>>,
    lifecycle: Arc<Mutex<PlayerLifecycle>>,
}

// If spawning the control thread fails, its captured runtime still tears down
// the renderer and embedded VO in the required order.
struct PlayerRuntime {
    api: Arc<MpvApi>,
    handle_address: usize,
    presentation: Option<Presentation>,
    _host: NativeSurface,
    _registry: Arc<MpvStreamRegistry>,
}

impl Drop for PlayerRuntime {
    fn drop(&mut self) {
        if let Some(presentation) = self.presentation.take() {
            presentation.stop();
        }
        self.api.destroy(self.handle_address as *mut MpvHandle);
    }
}

fn requested_backends() -> Result<Vec<Backend>, String> {
    #[cfg(target_os = "windows")]
    return windows_backends(
        &std::env::var("VESPERWIND_MPV_WINDOWS_BACKEND").unwrap_or_else(|_| "auto".into()),
    );
    #[cfg(not(target_os = "windows"))]
    Ok(vec![Backend::RenderApi])
}

#[cfg(target_os = "windows")]
fn windows_backends(mode: &str) -> Result<Vec<Backend>, String> {
    match mode {
        "auto" => Ok(vec![Backend::D3d11, Backend::RenderApi]),
        "d3d11" => Ok(vec![Backend::D3d11]),
        "wgl" => Ok(vec![Backend::RenderApi]),
        _ => Err("VESPERWIND_MPV_WINDOWS_BACKEND must be auto, d3d11 or wgl".into()),
    }
}

pub struct MpvPlayerManager {
    ssh: Arc<SshManager>,
    registry: Arc<MpvStreamRegistry>,
    running: Mutex<Option<RunningPlayer>>,
    overlay_context: Mutex<Option<(String, Value)>>,
}

impl MpvPlayerManager {
    pub fn new(ssh: Arc<SshManager>) -> Arc<Self> {
        Arc::new(Self {
            registry: MpvStreamRegistry::new(Arc::clone(&ssh)),
            ssh,
            running: Mutex::new(None),
            overlay_context: Mutex::new(None),
        })
    }

    fn ensure_started(
        &self,
        session_id: &str,
        window: &Window,
        app: &AppHandle,
        backend: Backend,
        fallback_reason: Option<String>,
    ) -> Result<(), String> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(active) = running.as_ref() {
            return Err(format!(
                "Cannot open native player session {session_id}; session {} is still active",
                active.session_id
            ));
        }
        eprintln!("[player={session_id}] create requested");
        let api = Arc::new(MpvApi::load_bundled()?);
        let surface = match backend {
            Backend::RenderApi => NativeSurface::create(window)?,
            #[cfg(target_os = "windows")]
            Backend::D3d11 => NativeSurface::create_video_host(window)?,
        };
        let host = match backend {
            Backend::RenderApi => None,
            #[cfg(target_os = "windows")]
            Backend::D3d11 => Some(surface.host_address()),
        };
        let registry = Arc::as_ptr(&self.registry).cast_mut().cast();
        let handle = match host {
            Some(host) => api.initialize_for_host(registry, Some(host))?,
            None => api.initialize_for_streams(registry)?,
        };
        eprintln!(
            "[player={session_id}] mpv handle created backend={}",
            backend.name()
        );
        surface.refresh_display_capabilities();
        let display = surface.display_capabilities();
        if let Err(error) = configure_display_output(&api, handle, &display) {
            api.destroy(handle);
            return Err(error);
        }
        let presentation = match Presentation::start(
            Arc::clone(&api),
            handle,
            surface.clone(),
            session_id,
            backend,
        ) {
            Ok(presentation) => presentation,
            Err(error) => {
                api.destroy(handle);
                return Err(error);
            }
        };
        let runtime = PlayerRuntime {
            api,
            handle_address: handle as usize,
            presentation: Some(presentation),
            _host: surface.clone(),
            _registry: Arc::clone(&self.registry),
        };
        let (sender, receiver) = mpsc::channel();
        let registry = Arc::clone(&self.registry);
        let control_surface = surface.clone();
        let app = app.clone();
        let control_session_id = session_id.to_string();
        let lifecycle = Arc::new(Mutex::new(PlayerLifecycle::Opening));
        let control_lifecycle = Arc::clone(&lifecycle);
        let thread = thread::Builder::new()
            .name("vesperwind-mpv-control".to_string())
            .spawn(move || {
                control_loop(
                    runtime,
                    registry,
                    control_surface,
                    receiver,
                    app,
                    control_session_id,
                    control_lifecycle,
                    backend,
                    fallback_reason,
                )
            })
            .map_err(|error| error.to_string())?;
        *running = Some(RunningPlayer {
            session_id: session_id.to_string(),
            sender,
            surface,
            thread: Some(thread),
            lifecycle,
        });
        eprintln!("[player={session_id}] inserted into registry");
        Ok(())
    }

    pub fn open(
        &self,
        filesystem: &Filesystem,
        window: &Window,
        app: &AppHandle,
        session_id: &str,
        provider_id: Option<&str>,
        path: &str,
        autoplay: bool,
        geometry: PlayerGeometry,
    ) -> Result<PlayerSnapshot, String> {
        eprintln!("[player={session_id}] open requested source={path}");
        let backends = requested_backends()?;
        let mut fallback_reason = None;
        for (index, backend) in backends.iter().copied().enumerate() {
            let can_fallback = index + 1 < backends.len();
            let source = ContentSource::open(filesystem, &self.ssh, provider_id, path)
                .map_err(|error| error.message)?;
            if let Err(error) =
                self.ensure_started(session_id, window, app, backend, fallback_reason.clone())
            {
                if !can_fallback {
                    return Err(error);
                }
                eprintln!("[player={session_id}] presentation startup failed; trying WGL: {error}");
                fallback_reason = Some(error);
                continue;
            }
            let uri = self.registry.register(source);
            eprintln!("[player={session_id}] source load requested");
            let result = self.with_running(session_id, true, |running| {
                running.surface.set_geometry(geometry)?;
                running.surface.set_visible(true)?;
                running
                    .sender
                    .send(Control::SetSubtitlePosition(geometry.subtitle_position))
                    .map_err(|_| "The native player control channel is closed".to_string())?;
                request(&running.sender, |reply| Control::Load {
                    uri: uri.clone(),
                    autoplay,
                    reply,
                })
            });
            if let Err(error) = &result {
                eprintln!("[player={session_id}] open failed: {error}");
                self.registry.remove(&uri);
                self.close(session_id);
                if can_fallback && error.starts_with("D3D11 presentation initialization failed:") {
                    fallback_reason = Some(error.clone());
                    continue;
                }
            }
            return result;
        }
        Err("No Windows presentation backend could start".into())
    }

    pub fn set_geometry(&self, session_id: &str, geometry: PlayerGeometry) -> Result<(), String> {
        self.with_running(session_id, false, |running| {
            running.surface.set_geometry(geometry)?;
            running
                .sender
                .send(Control::SetSubtitlePosition(geometry.subtitle_position))
                .map_err(|_| "The native player control channel is closed".to_string())
        })
    }

    pub fn set_visible(&self, session_id: &str, visible: bool) -> Result<(), String> {
        self.with_running(session_id, false, |running| {
            running.surface.set_transition_visible(visible)
        })
    }

    pub fn set_overlay_context(&self, session_id: &str, context: Value) {
        *self
            .overlay_context
            .lock()
            .unwrap_or_else(|value| value.into_inner()) = Some((session_id.to_string(), context));
    }

    pub fn overlay_context_snapshot(&self) -> Value {
        self.overlay_context
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .as_ref()
            .map(|(_, context)| context.clone())
            .unwrap_or_else(|| json!({}))
    }

    pub fn assert_session(&self, session_id: &str) -> Result<(), String> {
        self.with_running(session_id, false, |_| Ok(()))
    }

    pub fn play(&self, session_id: &str) -> Result<PlayerSnapshot, String> {
        eprintln!("[player={session_id}] play");
        let started = Instant::now();
        let result = self.with_request(session_id, Control::Play);
        eprintln!(
            "[player={session_id}] play completed_ms={}",
            started.elapsed().as_millis()
        );
        result
    }
    pub fn pause(&self, session_id: &str) -> Result<PlayerSnapshot, String> {
        eprintln!("[player={session_id}] pause");
        let started = Instant::now();
        let result = self.with_request(session_id, Control::Pause);
        eprintln!(
            "[player={session_id}] pause completed_ms={}",
            started.elapsed().as_millis()
        );
        result
    }
    pub fn snapshot(&self, session_id: &str) -> Result<PlayerSnapshot, String> {
        self.with_request(session_id, Control::Snapshot)
    }
    pub fn seek(&self, session_id: &str, seconds: f64) -> Result<PlayerSnapshot, String> {
        eprintln!("[player={session_id}] seek seconds={seconds}");
        self.with_running(session_id, false, |running| {
            request(&running.sender, |reply| Control::Seek { seconds, reply })
        })
    }
    pub fn set_volume(&self, session_id: &str, volume: f64) -> Result<PlayerSnapshot, String> {
        self.with_running(session_id, false, |running| {
            request(&running.sender, |reply| Control::SetVolume {
                volume,
                reply,
            })
        })
    }
    pub fn set_muted(&self, session_id: &str, muted: bool) -> Result<PlayerSnapshot, String> {
        self.with_running(session_id, false, |running| {
            request(&running.sender, |reply| Control::SetMuted { muted, reply })
        })
    }
    pub fn select_track(
        &self,
        session_id: &str,
        kind: String,
        id: Option<i64>,
    ) -> Result<PlayerSnapshot, String> {
        self.with_running(session_id, false, |running| {
            request(&running.sender, |reply| Control::SelectTrack {
                kind,
                id,
                reply,
            })
        })
    }
    pub fn set_subtitle_delay(
        &self,
        session_id: &str,
        seconds: f64,
    ) -> Result<PlayerSnapshot, String> {
        self.with_running(session_id, false, |running| {
            request(&running.sender, |reply| Control::SetSubtitleDelay {
                seconds,
                reply,
            })
        })
    }

    fn with_request(
        &self,
        session_id: &str,
        constructor: fn(mpsc::SyncSender<Result<PlayerSnapshot, String>>) -> Control,
    ) -> Result<PlayerSnapshot, String> {
        self.with_running(session_id, false, |running| {
            request(&running.sender, constructor)
        })
    }

    fn with_running<T>(
        &self,
        session_id: &str,
        allow_opening: bool,
        operation: impl FnOnce(&RunningPlayer) -> Result<T, String>,
    ) -> Result<T, String> {
        let running = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        let Some(active) = running.as_ref() else {
            eprintln!("[player={session_id}] command rejected: native player is not open for this session; registry=[]");
            return Err(format!(
                "The native player is not open for session {session_id}"
            ));
        };
        if active.session_id != session_id {
            eprintln!(
                "[player={session_id}] command rejected: native player is not open for this session; registry=[{}]",
                active.session_id
            );
            return Err(format!(
                "The native player is not open for session {session_id}"
            ));
        }
        let lifecycle = *active
            .lifecycle
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if !allow_opening && !lifecycle.accepts_commands() {
            return Err(format!(
                "Native player session {session_id} is not ready (state={lifecycle:?})"
            ));
        }
        operation(active)
    }

    pub fn close(&self, session_id: &str) -> bool {
        eprintln!("[player={session_id}] close requested");
        let mut guard = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if !is_target_session(
            guard.as_ref().map(|player| player.session_id.as_str()),
            session_id,
        ) {
            eprintln!(
                "[player={session_id}] close ignored; registry contains {:?}",
                guard.as_ref().map(|player| player.session_id.as_str())
            );
            return false;
        }
        let mut running = guard.take();
        drop(guard);
        if let Some(mut running) = running.take() {
            *running
                .lifecycle
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = PlayerLifecycle::Closing;
            let _ = running.surface.set_visible(false);
            let (reply, finished) = mpsc::sync_channel(1);
            let _ = running.sender.send(Control::Shutdown(reply));
            let _ = finished.recv_timeout(Duration::from_secs(5));
            if let Some(thread) = running.thread.take() {
                let _ = thread.join();
            }
            *running
                .lifecycle
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = PlayerLifecycle::Closed;
            eprintln!("[player={session_id}] registry removal and destruction complete");
        }
        let mut overlay = self
            .overlay_context
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if overlay.as_ref().map(|(id, _)| id.as_str()) == Some(session_id) {
            *overlay = None;
        }
        true
    }

    pub fn close_all(&self) {
        let session_id = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .as_ref()
            .map(|player| player.session_id.clone());
        if let Some(session_id) = session_id {
            self.close(&session_id);
        }
    }
}

impl Drop for MpvPlayerManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn request(
    sender: &mpsc::Sender<Control>,
    constructor: impl FnOnce(mpsc::SyncSender<Result<PlayerSnapshot, String>>) -> Control,
) -> Result<PlayerSnapshot, String> {
    let (reply, response) = mpsc::sync_channel(1);
    sender
        .send(constructor(reply))
        .map_err(|_| "The native player has stopped".to_string())?;
    response
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "The native player did not respond".to_string())?
}

fn control_loop(
    runtime: PlayerRuntime,
    registry: Arc<MpvStreamRegistry>,
    surface: NativeSurface,
    receiver: mpsc::Receiver<Control>,
    app: AppHandle,
    session_id: String,
    lifecycle: Arc<Mutex<PlayerLifecycle>>,
    backend: Backend,
    fallback_reason: Option<String>,
) {
    #[cfg(not(target_os = "windows"))]
    let _ = backend;
    let api = Arc::clone(&runtime.api);
    let handle = runtime.handle_address as *mut MpvHandle;
    let mut current_uri: Option<String> = None;
    let mut state = PlayerSnapshot::default();
    state.diagnostics.presentation_fallback_reason = fallback_reason;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_display_refresh = Instant::now() - Duration::from_secs(1);
    let mut last_metadata_refresh = Instant::now() - Duration::from_secs(1);
    let mut last_performance_log = Instant::now();
    let mut display = surface.display_capabilities();
    let mut shutdown_reply = None;
    let mut eof_handled = false;
    #[cfg(target_os = "windows")]
    let mut output_policy = Some(WindowsOutputPolicy::Sdr);
    let mut waiting_for_vo: Option<Instant> = None;
    let mut pending_load: Option<(
        mpsc::SyncSender<Result<PlayerSnapshot, String>>,
        bool,
        String,
    )> = None;
    'running: loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Control::Load {
                uri,
                autoplay,
                reply,
            }) => {
                eof_handled = false;
                *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                    PlayerLifecycle::Opening;
                state.status = "opening".to_string();
                state.error = None;
                emit_state(&app, &session_id, &state);
                let result = api
                    .set_property(handle, "pause", "yes")
                    .and_then(|_| api.command(handle, &["loadfile", &uri, "replace"]));
                if let Err(error) = result {
                    *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                        PlayerLifecycle::Error;
                    let _ = reply.send(Err(error));
                } else {
                    pending_load = Some((reply, autoplay, uri));
                }
            }
            Ok(Control::Play(reply)) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "pause", "no")
                });
                *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                    PlayerLifecycle::Playing;
            }
            Ok(Control::Pause(reply)) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "pause", "yes")
                });
                *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                    PlayerLifecycle::Paused;
            }
            Ok(Control::Seek { seconds, reply }) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.command(
                        handle,
                        &["seek", &seconds.max(0.0).to_string(), "absolute+exact"],
                    )
                })
            }
            Ok(Control::SetVolume { volume, reply }) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(
                        handle,
                        "volume",
                        &(volume.clamp(0.0, 1.0) * 100.0).to_string(),
                    )
                })
            }
            Ok(Control::SetMuted { muted, reply }) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "mute", if muted { "yes" } else { "no" })
                })
            }
            Ok(Control::SelectTrack { kind, id, reply }) => {
                reply_with(&api, handle, &mut state, reply, move |api, handle| {
                    let property = match kind.as_str() {
                        "audio" => "aid",
                        "subtitle" => "sid",
                        _ => return Err("Unknown track type".to_string()),
                    };
                    api.set_property(
                        handle,
                        property,
                        &id.map(|value| value.to_string())
                            .unwrap_or_else(|| "no".to_string()),
                    )
                })
            }
            Ok(Control::SetSubtitleDelay { seconds, reply }) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "sub-delay", &seconds.clamp(-30.0, 30.0).to_string())
                })
            }
            Ok(Control::SetSubtitlePosition(position)) => {
                let _ =
                    api.set_property(handle, "sub-pos", &position.clamp(0.0, 100.0).to_string());
            }
            Ok(Control::Snapshot(reply)) => {
                state = read_snapshot(&api, handle, &state, &display);
                state.presentation = runtime.presentation.as_ref().unwrap().presentation();
                let _ = reply.send(Ok(state.clone()));
            }
            Ok(Control::Shutdown(reply)) => {
                shutdown_reply = Some(reply);
                break 'running;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break 'running,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        let mut event_changed = false;
        loop {
            let event = if waiting_for_vo.is_some()
                && api.get_flag(handle, "vo-configured") == Some(true)
            {
                waiting_for_vo = None;
                // Complete deferred startup without consuming a queued event,
                // especially END_FILE or SHUTDOWN.
                super::MpvEventDetails {
                    event_id: MPV_EVENT_FILE_LOADED,
                    error: 0,
                    end_file_error: 0,
                }
            } else {
                api.wait_event_details(handle, 0.0)
            };
            match event.event_id {
                MPV_EVENT_NONE => break,
                MPV_EVENT_FILE_LOADED => {
                    #[cfg(target_os = "windows")]
                    if backend == Backend::D3d11 {
                        update_windows_output_policy(&api, handle, &display, &mut output_policy);
                    }
                    #[cfg(target_os = "windows")]
                    if backend == Backend::D3d11
                        && api.get_i64(handle, "current-tracks/video/id").is_some()
                        && api.get_flag(handle, "vo-configured") != Some(true)
                    {
                        // FILE_LOADED precedes first-frame VO configuration.
                        // Keep opening until VO startup completes or fails;
                        // this does not gate fullscreen transitions.
                        waiting_for_vo = Some(Instant::now());
                        continue;
                    }
                    state.error = None;
                    state = read_snapshot(&api, handle, &state, &display);
                    state.status = "ready".into();
                    *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                        PlayerLifecycle::Ready;
                    eprintln!("[player={session_id}] source loaded");
                    eprintln!("[player={session_id}] ready");
                    emit_state(&app, &session_id, &state);
                    if let Some((reply, autoplay, uri)) = pending_load.take() {
                        if let Some(previous) = current_uri.replace(uri) {
                            registry.remove(&previous);
                        }
                        if autoplay {
                            let result = api.set_property(handle, "pause", "no").map(|_| {
                                state.status = "playing".into();
                                state = read_snapshot(&api, handle, &state, &display);
                                *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                                    PlayerLifecycle::Playing;
                                emit_state(&app, &session_id, &state);
                                state.clone()
                            });
                            let _ = reply.send(result);
                        } else {
                            let _ = reply.send(Ok(state.clone()));
                        }
                    }
                    event_changed = true;
                }
                MPV_EVENT_END_FILE => {
                    waiting_for_vo = None;
                    let error = if event.end_file_error < 0 {
                        event.end_file_error
                    } else {
                        event.error
                    };
                    if error < 0 {
                        state.status = "error".into();
                        let message = format!(
                            "libmpv could not play this file: {}",
                            api.error_string(error)
                        );
                        #[cfg(target_os = "windows")]
                        let message = if backend == Backend::D3d11 && error == -15 {
                            format!("D3D11 presentation initialization failed: {message}")
                        } else {
                            message
                        };
                        state.error = Some(message.clone());
                        *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                            PlayerLifecycle::Error;
                        if let Some((reply, _, uri)) = pending_load.take() {
                            registry.remove(&uri);
                            let _ = reply.send(Err(message));
                        }
                    } else {
                        state.status = "ended".into();
                    }
                    event_changed = true;
                }
                MPV_EVENT_SHUTDOWN => break 'running,
                _ => {}
            }
        }
        if waiting_for_vo.is_some_and(|started| started.elapsed() >= Duration::from_secs(10)) {
            waiting_for_vo = None;
            let message = "D3D11 presentation initialization failed: video output did not configure within 10 seconds".to_string();
            if let Some((reply, _, uri)) = pending_load.take() {
                registry.remove(&uri);
                let _ = reply.send(Err(message.clone()));
            }
            state.error = Some(message);
            state.status = "error".into();
            *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) = PlayerLifecycle::Error;
        }
        if last_emit.elapsed() >= Duration::from_millis(100) {
            // keep-open retains the file and last frame at EOF, so no END_FILE
            // event is required. Rewind once and leave replay under user control.
            let at_eof = api.get_flag(handle, "eof-reached") == Some(true);
            if at_eof && !eof_handled && pending_load.is_none() && current_uri.is_some() {
                eof_handled = true;
                match rewind_after_eof(&api, handle) {
                    Ok(()) => {
                        state.status = "paused".into();
                        state.current_time = 0.0;
                        *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) =
                            PlayerLifecycle::Paused;
                        eprintln!("[player={session_id}] EOF rewound to start and paused");
                    }
                    Err(message) => {
                        state.status = "error".into();
                        state.error = Some(message);
                    }
                }
                event_changed = true;
            } else if !at_eof {
                eof_handled = false;
            }
            if last_display_refresh.elapsed() >= Duration::from_secs(2) {
                surface.refresh_display_capabilities();
                let next_display = surface.display_capabilities();
                if next_display != display {
                    let _ = configure_display_output(&api, handle, &next_display);
                    display = next_display;
                    event_changed = true;
                }
                last_display_refresh = Instant::now();
            }
            state.presentation = runtime.presentation.as_ref().unwrap().presentation();
            // Time/volume update frequently; codec/HDR metadata and track lists
            // require many synchronous mpv property queries and change rarely.
            let next = if event_changed || last_metadata_refresh.elapsed() >= Duration::from_secs(1)
            {
                #[cfg(target_os = "windows")]
                if backend == Backend::D3d11 {
                    update_windows_output_policy(&api, handle, &display, &mut output_policy);
                }
                last_metadata_refresh = Instant::now();
                read_snapshot(&api, handle, &state, &display)
            } else {
                read_playback_state(&api, handle, &state)
            };
            if next != state || event_changed {
                state = next;
                emit_state(&app, &session_id, &state);
            }
            last_emit = Instant::now();
            if std::env::var_os("VESPERWIND_MPV_LOG").is_some()
                && last_performance_log.elapsed() >= Duration::from_secs(5)
            {
                eprintln!("[player={session_id}] performance time={:.2} hwdec={:?} decoded={:?} dropped={:?} decoder_dropped={:?} delayed={:?} video_sync={:?} av_sync={:?} output={:?}",
                    state.current_time, state.diagnostics.hardware_decoder,
                    state.diagnostics.source_pixel_format, state.diagnostics.dropped_frames,
                    state.diagnostics.decoder_dropped_frames, state.diagnostics.delayed_frames,
                    state.diagnostics.video_sync, state.diagnostics.av_sync_seconds, state.diagnostics.windows_output);
                last_performance_log = Instant::now();
            }
        }
    }

    let _ = api.command(handle, &["stop"]);
    if let Some((reply, _, uri)) = pending_load {
        registry.remove(&uri);
        let _ = reply.send(Err(
            "The native player closed while opening the source".into()
        ));
    }
    if let Some(uri) = current_uri {
        registry.remove(&uri);
    }
    // Destroy the VO while both its host and callback registry are still alive.
    drop(runtime);
    *lifecycle.lock().unwrap_or_else(|value| value.into_inner()) = PlayerLifecycle::Closed;
    let _ = app.emit(
        "player:state",
        json!({ "sessionId": session_id, "status": "closed" }),
    );
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(());
    }
}

pub(super) fn rewind_after_eof(api: &MpvApi, handle: *mut MpvHandle) -> Result<(), String> {
    api.set_property(handle, "pause", "yes")?;
    api.command(handle, &["seek", "0", "absolute+exact"])
}

fn reply_with(
    api: &MpvApi,
    handle: *mut MpvHandle,
    state: &mut PlayerSnapshot,
    reply: mpsc::SyncSender<Result<PlayerSnapshot, String>>,
    operation: impl FnOnce(&MpvApi, *mut MpvHandle) -> Result<(), String>,
) {
    let result = operation(api, handle).map(|_| {
        let display = state.diagnostics.display.clone();
        read_snapshot(api, handle, state, &display)
    });
    if let Ok(next) = &result {
        *state = next.clone();
    }
    let _ = reply.send(result);
}

fn read_snapshot(
    api: &MpvApi,
    handle: *mut MpvHandle,
    previous: &PlayerSnapshot,
    display: &DisplayCapabilities,
) -> PlayerSnapshot {
    let mut state = read_playback_state(api, handle, previous);
    state.tracks = read_tracks(api, handle);
    state.diagnostics = read_diagnostics(api, handle, display);
    state.diagnostics.presentation_fallback_reason =
        previous.diagnostics.presentation_fallback_reason.clone();
    state
}

fn read_playback_state(
    api: &MpvApi,
    handle: *mut MpvHandle,
    previous: &PlayerSnapshot,
) -> PlayerSnapshot {
    let paused = api
        .get_flag(handle, "pause")
        .unwrap_or(previous.status == "paused");
    let mut status = previous.status.clone();
    if matches!(status.as_str(), "ready" | "playing" | "paused") {
        status = if paused {
            "paused".into()
        } else {
            "playing".into()
        };
    }
    PlayerSnapshot {
        presentation: previous.presentation.clone(),
        status,
        current_time: api
            .get_double(handle, "time-pos")
            .unwrap_or(previous.current_time)
            .max(0.0),
        duration: api
            .get_double(handle, "duration")
            .unwrap_or(previous.duration)
            .max(0.0),
        volume: (api
            .get_double(handle, "volume")
            .unwrap_or(previous.volume * 100.0)
            / 100.0)
            .clamp(0.0, 1.0),
        muted: api.get_flag(handle, "mute").unwrap_or(previous.muted),
        subtitle_delay: api
            .get_double(handle, "sub-delay")
            .unwrap_or(previous.subtitle_delay),
        tracks: previous.tracks.clone(),
        diagnostics: previous.diagnostics.clone(),
        error: previous.error.clone(),
    }
}

fn configure_display_output(
    api: &MpvApi,
    handle: *mut MpvHandle,
    display: &DisplayCapabilities,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let edr = display.output_supported && display.hdr_capable;
        api.set_property(
            handle,
            "target-trc",
            if edr { "linear" } else { "gamma2.2" },
        )?;
        api.set_property(
            handle,
            "target-prim",
            if edr { "display-p3" } else { "bt.709" },
        )?;
        let headroom = if edr {
            display.current_headroom.max(1.0)
        } else {
            1.0
        };
        api.set_property(handle, "target-peak", &(203.0 * headroom).to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (api, handle, display);
    Ok(())
}

#[cfg(target_os = "windows")]
fn update_windows_output_policy(
    api: &MpvApi,
    handle: *mut MpvHandle,
    display: &DisplayCapabilities,
    applied: &mut Option<WindowsOutputPolicy>,
) {
    let transfer = api.get_string(handle, "video-params/gamma");
    let primaries = api.get_string(handle, "video-params/primaries");
    let (policy, _) =
        WindowsOutputPolicy::select(transfer.as_deref(), primaries.as_deref(), display);
    if *applied == Some(policy) {
        return;
    }
    for (name, value) in policy.options() {
        if let Err(error) = api.set_property(handle, name, value) {
            // If an HDR option fails, restore SDR as a complete policy. Actual
            // options + target params below prevent claiming partial success.
            for (sdr_name, sdr_value) in WindowsOutputPolicy::Sdr.options() {
                let _ = api.set_property(handle, sdr_name, sdr_value);
            }
            *applied = None;
            eprintln!("[HDR10] output policy failed ({name}={value}): {error}");
            return;
        }
    }
    *applied = Some(policy);
    eprintln!(
        "[HDR10] requested output policy={policy:?}; negotiated target must be verified separately"
    );
}

fn read_hdr_metadata(api: &MpvApi, handle: *mut MpvHandle, prefix: &str) -> HdrMetadataDiagnostics {
    let get = |name: &str| {
        api.get_double(handle, &format!("{prefix}/{name}"))
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    let coordinates: Option<Vec<f64>> = [
        "prim-red-x",
        "prim-red-y",
        "prim-green-x",
        "prim-green-y",
        "prim-blue-x",
        "prim-blue-y",
        "prim-white-x",
        "prim-white-y",
    ]
    .into_iter()
    .map(get)
    .collect();
    HdrMetadataDiagnostics {
        min_luminance_nits: get("min-luma"),
        max_luminance_nits: get("max-luma").filter(|value| *value > 0.0),
        max_cll_nits: get("max-cll").filter(|value| *value > 0.0),
        max_fall_nits: get("max-fall").filter(|value| *value > 0.0),
        mastering_primaries: coordinates.and_then(|v| v.try_into().ok()),
    }
}

fn read_diagnostics(
    api: &MpvApi,
    handle: *mut MpvHandle,
    display: &DisplayCapabilities,
) -> PlaybackDiagnostics {
    let transfer = api.get_string(handle, "video-params/gamma");
    let primaries = api.get_string(handle, "video-params/primaries");
    let pixel_format = api.get_string(handle, "video-params/pixelformat");
    let source_pixel_format = api
        .get_string(handle, "video-dec-params/pixelformat")
        .or_else(|| pixel_format.clone());
    let codec_profile = api.get_string(handle, "current-tracks/video/codec-profile");
    let file_size = api.get_i64(handle, "file-size").filter(|value| *value > 0);
    let duration = api
        .get_double(handle, "duration")
        .filter(|value| *value > 0.0);
    let video_codec = api.get_string(handle, "current-tracks/video/codec");
    let audio_codec = api.get_string(handle, "current-tracks/audio/codec");
    let source_chroma = source_chroma_subsampling(
        source_pixel_format.as_deref(),
        video_codec.as_deref(),
        codec_profile.as_deref(),
    );
    let dolby_vision_profile = api.get_i64(handle, "current-tracks/video/dolby-vision-profile");
    let dolby_vision_level = api.get_i64(handle, "current-tracks/video/dolby-vision-level");
    let (source_hdr, source_format) = classify_hdr_source(
        transfer.as_deref(),
        primaries.as_deref(),
        dolby_vision_profile,
    );
    let mut output_hdr_active = is_hdr_output_active(source_hdr, display);
    let target_peak_nits =
        (display.platform == "macos").then_some(203.0 * display.current_headroom.max(1.0));
    let mut tone_mapping = if !source_hdr {
        "none".to_string()
    } else if output_hdr_active {
        "display-adaptive to current EDR headroom".to_string()
    } else {
        "HDR-to-SDR fallback".to_string()
    };
    let mut output_mode = if output_hdr_active {
        "HDR (macOS EDR)".to_string()
    } else if source_hdr {
        "SDR fallback".to_string()
    } else {
        "SDR".to_string()
    };
    let mut output_color_space = if output_hdr_active {
        "linear Display P3".to_string()
    } else {
        "BT.709".to_string()
    };
    let mut fallback_reason = (source_hdr && !output_hdr_active).then(|| {
        display.reason.clone().unwrap_or_else(|| {
            if !display.output_supported {
                "The native surface cannot present HDR".to_string()
            } else if !display.hdr_capable {
                "The current display does not report HDR/EDR capability".to_string()
            } else {
                "The current display reports no usable EDR headroom".to_string()
            }
        })
    });
    let windows_output = if display.platform == "windows"
        && display.surface_format.starts_with("mpv-owned D3D11")
    {
        let (policy, reason) =
            WindowsOutputPolicy::select(transfer.as_deref(), primaries.as_deref(), display);
        let target_transfer = api.get_string(handle, "video-target-params/gamma");
        let target_primaries = api.get_string(handle, "video-target-params/primaries");
        let target_pixel_format = api.get_string(handle, "video-target-params/pixelformat");
        let requested_transfer = api.get_string(handle, "target-trc");
        let requested_primaries = api.get_string(handle, "target-prim");
        let options = policy.options();
        let target_verified = requested_transfer.as_deref()
            == options
                .iter()
                .find(|(name, _)| *name == "target-trc")
                .map(|(_, value)| *value)
            && requested_primaries.as_deref()
                == options
                    .iter()
                    .find(|(name, _)| *name == "target-prim")
                    .map(|(_, value)| *value)
            && policy.matches_target(
                target_transfer.as_deref(),
                target_primaries.as_deref(),
                target_pixel_format.as_deref(),
            );
        output_hdr_active = policy == WindowsOutputPolicy::Hdr10 && target_verified;
        let sdr_verified = WindowsOutputPolicy::Sdr.matches_target(
            target_transfer.as_deref(),
            target_primaries.as_deref(),
            target_pixel_format.as_deref(),
        );
        output_mode = if output_hdr_active {
            "HDR10 (mpv target verified)"
        } else if sdr_verified && source_hdr {
            "SDR fallback"
        } else if sdr_verified {
            "SDR"
        } else {
            "Not verified (output changing or unavailable)"
        }
        .into();
        output_color_space = if output_hdr_active {
            "PQ / BT.2020"
        } else if sdr_verified {
            "BT.709"
        } else {
            "not verified"
        }
        .into();
        tone_mapping = if !source_hdr {
            "none"
        } else if output_hdr_active {
            "HDR display mapping (libplacebo)"
        } else if sdr_verified {
            "HDR-to-SDR fallback"
        } else {
            "not verified"
        }
        .into();
        fallback_reason =
            (source_hdr && !output_hdr_active).then(|| {
                reason.unwrap_or_else(||
            "HDR10 target not negotiated; reopen the player if this persists (see mpv log)".into())
            });
        Some(WindowsOutputDiagnostics {
            requested: if policy == WindowsOutputPolicy::Hdr10 { "HDR10 / PQ / BT.2020" } else { "SDR / gamma 2.2 / BT.709" }.into(),
            requested_transfer, requested_primaries, target_verified,
            dxgi_format: dxgi_format(target_pixel_format.as_deref()).map(str::to_string),
            format_evidence: "Actual backbuffer format via mpv video-target-params (pinned libplacebo format mapping)".into(),
            expected_dxgi_color_space: if output_hdr_active { Some("DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020".into()) }
                else if sdr_verified { Some("DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709".into()) } else { None },
            color_space_evidence: "Expected from verified mpv target and pinned libplacebo mapping; DXGI SetColorSpace1 result is not exposed by the client API".into(),
            hdr_metadata_state: "not verified: DXGI SetHDRMetaData result is not exposed by the client API".into(),
            target_hdr_metadata: read_hdr_metadata(api, handle, "video-target-params"),
            target_transfer, target_primaries, target_pixel_format,
        })
    } else {
        None
    };
    let container = api.get_string(handle, "file-format");
    let matrix = api.get_string(handle, "video-params/colormatrix");
    PlaybackDiagnostics {
        presentation_fallback_reason: None,
        friendly_container: container.as_deref().map(friendly_container_name),
        container,
        file_size,
        duration,
        overall_bitrate: file_size
            .zip(duration)
            .map(|(bytes, seconds)| bytes as f64 * 8.0 / seconds),
        video: VideoDiagnostics {
            friendly_codec: video_codec.as_deref().map(friendly_codec_name),
            codec: video_codec,
            profile: codec_profile.clone(),
            level: api.get_string(handle, "current-tracks/video/codec-level"),
            width: api
                .get_i64(handle, "video-params/w")
                .filter(|value| *value > 0),
            height: api
                .get_i64(handle, "video-params/h")
                .filter(|value| *value > 0),
            frame_rate: api
                .get_double(handle, "container-fps")
                .or_else(|| api.get_double(handle, "estimated-vf-fps"))
                .filter(|value| *value > 0.0),
            progressive: api
                .get_flag(handle, "video-frame-info/interlaced")
                .or_else(|| api.get_flag(handle, "video-dec-params/interlaced"))
                .or_else(|| api.get_flag(handle, "video-params/interlaced"))
                .map(|interlaced| !interlaced),
            bitrate: track_average_bitrate(api, handle, "current-tracks/video"),
            chroma: source_chroma,
            friendly_matrix: matrix.as_deref().map(friendly_color_name),
            matrix,
        },
        audio: AudioDiagnostics {
            friendly_codec: audio_codec.as_deref().map(friendly_codec_name),
            codec: audio_codec,
            bitrate: track_average_bitrate(api, handle, "current-tracks/audio"),
            channel_layout: api
                .get_string(handle, "current-tracks/audio/demux-channels")
                .or_else(|| api.get_string(handle, "audio-params/channels")),
            channel_count: api
                .get_i64(handle, "current-tracks/audio/demux-channel-count")
                .or_else(|| api.get_i64(handle, "audio-params/channel-count"))
                .filter(|value| *value > 0),
            sample_rate: api
                .get_i64(handle, "current-tracks/audio/demux-samplerate")
                .or_else(|| api.get_i64(handle, "audio-params/samplerate"))
                .filter(|value| *value > 0),
            language: api.get_string(handle, "current-tracks/audio/lang"),
            friendly_language: api
                .get_string(handle, "current-tracks/audio/lang")
                .as_deref()
                .map(friendly_language_name),
            title: api.get_string(handle, "current-tracks/audio/title"),
        },
        subtitle: SubtitleDiagnostics {
            friendly_format: api
                .get_string(handle, "current-tracks/sub/codec")
                .as_deref()
                .map(friendly_subtitle_name),
            format: api.get_string(handle, "current-tracks/sub/codec"),
            language: api.get_string(handle, "current-tracks/sub/lang"),
            friendly_language: api
                .get_string(handle, "current-tracks/sub/lang")
                .as_deref()
                .map(friendly_language_name),
            title: api.get_string(handle, "current-tracks/sub/title"),
            default: api.get_flag(handle, "current-tracks/sub/default"),
            forced: api.get_flag(handle, "current-tracks/sub/forced"),
        },
        source_hdr,
        source_format,
        friendly_transfer: transfer.as_deref().map(friendly_color_name),
        transfer,
        friendly_primaries: primaries.as_deref().map(friendly_color_name),
        primaries,
        bit_depth: detect_bit_depth(source_pixel_format.as_deref(), codec_profile.as_deref()),
        source_pixel_format,
        pixel_format,
        max_luminance_nits: api.get_double(handle, "video-params/max-luma"),
        max_cll_nits: api.get_double(handle, "video-params/max-cll"),
        max_fall_nits: api.get_double(handle, "video-params/max-fall"),
        dolby_vision_profile,
        dolby_vision_level,
        dolby_vision_support: dolby_vision_profile.map(dolby_vision_support),
        output_hdr_active,
        output_mode,
        output_color_space,
        tone_mapping,
        target_peak_nits,
        fallback_reason,
        decoder: api.get_string(handle, "current-tracks/video/decoder"),
        hardware_decoder: api
            .get_string(handle, "hwdec-current")
            .filter(|decoder| decoder != "no"),
        renderer: if display.surface_format.starts_with("mpv-owned D3D11") {
            "libmpv-owned gpu-next / D3D11 / DXGI".to_string()
        } else {
            Backend::RenderApi.name().to_string()
        },
        display: display.clone(),
        windows_output,
        dropped_frames: api.get_i64(handle, "frame-drop-count"),
        decoder_dropped_frames: api.get_i64(handle, "decoder-frame-drop-count"),
        delayed_frames: api.get_i64(handle, "vo-delayed-frame-count"),
        video_sync: api.get_string(handle, "video-sync"),
        av_sync_seconds: api.get_double(handle, "avsync"),
        source_hdr_metadata: read_hdr_metadata(api, handle, "video-params"),
    }
}

fn friendly_codec_name(codec: &str) -> String {
    match codec.to_ascii_lowercase().as_str() {
        "h264" | "avc" | "avc1" => "AVC / H.264",
        "hevc" | "h265" | "hev1" | "hvc1" => "HEVC / H.265",
        "eac3" | "e-ac-3" => "Dolby Digital Plus",
        "ac3" | "ac-3" => "Dolby Digital",
        "truehd" | "mlp" => "Dolby TrueHD",
        "dts-hd ma" | "dts-hdma" => "DTS-HD Master Audio",
        "dts" => "DTS",
        "aac" => "AAC",
        "opus" => "Opus",
        "vorbis" => "Vorbis",
        "flac" => "FLAC",
        _ => codec,
    }
    .to_string()
}

fn friendly_container_name(container: &str) -> String {
    match container.to_ascii_lowercase().as_str() {
        "mkv" | "matroska" => "Matroska",
        "mov,mp4,m4a,3gp,3g2,mj2" | "mp4" => "MPEG-4",
        "mpegts" | "mpeg-ts" => "MPEG transport stream",
        "webm" => "WebM",
        "avi" => "AVI",
        _ => container,
    }
    .to_string()
}

fn friendly_subtitle_name(codec: &str) -> String {
    match codec.to_ascii_lowercase().as_str() {
        "subrip" | "srt" => "SubRip / SRT",
        "ass" | "ssa" => "ASS / SSA",
        "webvtt" | "vtt" => "WebVTT",
        "hdmv_pgs_subtitle" | "pgs" => "PGS",
        "dvd_subtitle" | "vobsub" => "VobSub",
        _ => codec,
    }
    .to_string()
}

fn friendly_language_name(language: &str) -> String {
    let base = language
        .split(['-', '_'])
        .next()
        .unwrap_or(language)
        .to_ascii_lowercase();
    match base.as_str() {
        "ru" | "rus" => "Russian",
        "en" | "eng" => "English",
        "uk" | "ukr" => "Ukrainian",
        "ka" | "kat" | "geo" => "Georgian",
        "de" | "deu" | "ger" => "German",
        "fr" | "fra" | "fre" => "French",
        "es" | "spa" => "Spanish",
        "it" | "ita" => "Italian",
        "ja" | "jpn" => "Japanese",
        "ko" | "kor" => "Korean",
        "zh" | "zho" | "chi" => "Chinese",
        "und" => "Unknown language",
        _ => language,
    }
    .to_string()
}

fn friendly_color_name(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "bt.709" | "bt709" => "BT.709",
        "bt.2020" | "bt2020" | "bt.2020-ncl" | "bt2020nc" => "BT.2020",
        "bt.1886" | "bt1886" | "gamma2.4" => "BT.1886",
        "pq" | "st2084" | "smpte2084" => "PQ",
        "hlg" | "arib-std-b67" => "HLG",
        "display-p3" => "Display P3",
        _ => value,
    }
    .to_string()
}

fn track_average_bitrate(api: &MpvApi, handle: *mut MpvHandle, prefix: &str) -> Option<f64> {
    api.get_i64(handle, &format!("{prefix}/demux-bitrate"))
        .filter(|value| *value > 0)
        .map(|value| value as f64)
        .or_else(|| {
            api.get_string(handle, &format!("{prefix}/metadata/by-key/BPS"))
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| *value > 0.0)
        })
}

fn source_chroma_subsampling(
    pixel_format: Option<&str>,
    codec: Option<&str>,
    profile: Option<&str>,
) -> Option<String> {
    chroma_subsampling(pixel_format).or_else(|| {
        let codec = codec.unwrap_or_default().to_ascii_lowercase();
        let profile = profile.unwrap_or_default().to_ascii_lowercase();
        let known_420_profile = matches!(codec.as_str(), "h264" | "avc" | "avc1")
            && matches!(
                profile.as_str(),
                "baseline" | "constrained baseline" | "main" | "high"
            )
            || matches!(codec.as_str(), "hevc" | "h265" | "hev1" | "hvc1")
                && matches!(profile.as_str(), "main" | "main 10");
        known_420_profile.then(|| "YUV 4:2:0".to_string())
    })
}

fn chroma_subsampling(pixel_format: Option<&str>) -> Option<String> {
    let format = pixel_format?.to_ascii_lowercase();
    if format.contains("420") {
        Some("YUV 4:2:0".to_string())
    } else if format.contains("422") {
        Some("YUV 4:2:2".to_string())
    } else if format.contains("444") {
        Some("YUV 4:4:4".to_string())
    } else if format.contains("rgb") || format.contains("gbr") {
        Some("RGB 4:4:4".to_string())
    } else {
        None
    }
}

fn is_hdr_output_active(source_hdr: bool, display: &DisplayCapabilities) -> bool {
    display.platform == "macos"
        && source_hdr
        && display.output_supported
        && display.hdr_enabled
        && display.current_headroom > 1.0
}

fn classify_hdr_source(
    transfer: Option<&str>,
    primaries: Option<&str>,
    dolby_vision_profile: Option<i64>,
) -> (bool, Option<String>) {
    if let Some(profile) = dolby_vision_profile {
        return (true, Some(format!("Dolby Vision profile {profile}")));
    }
    let transfer = transfer.unwrap_or_default().to_ascii_lowercase();
    let primaries = primaries.unwrap_or_default().to_ascii_lowercase();
    if transfer.contains("hlg") {
        return (true, Some("HLG".to_string()));
    }
    if transfer.contains("pq") || transfer.contains("st2084") {
        return (
            true,
            Some(if primaries.contains("2020") {
                "HDR10 / PQ".to_string()
            } else {
                "PQ HDR".to_string()
            }),
        );
    }
    (false, None)
}

fn detect_bit_depth(pixel_format: Option<&str>, codec_profile: Option<&str>) -> Option<u32> {
    let format = pixel_format.unwrap_or_default().to_ascii_lowercase();
    for marker in ["p16", "p14", "p12", "p10", "p09"] {
        if format.contains(marker) {
            return marker[1..].parse().ok();
        }
    }
    if format.contains("p010") || format.contains("10le") || format.contains("10be") {
        return Some(10);
    }
    if format.contains("12le") || format.contains("12be") {
        return Some(12);
    }
    if codec_profile
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("10")
    {
        return Some(10);
    }
    (!format.is_empty()).then_some(8)
}

fn dolby_vision_support(profile: i64) -> String {
    match profile {
        5 => "profile 5 metadata detected; this bundle has libplacebo Dolby Vision processing disabled, so correct RPU reshaping is unavailable"
            .to_string(),
        7 => "dual-layer profile detected; the HDR10 base layer may be used, but RPU and MEL/FEL enhancement-layer reconstruction are not claimed"
            .to_string(),
        8 => "base-layer-compatible profile detected; the base layer may be used, but RPU processing is disabled in this bundle"
            .to_string(),
        _ => "profile detected; Dolby Vision RPU processing is disabled in this bundle".to_string(),
    }
}

fn read_tracks(api: &MpvApi, handle: *mut MpvHandle) -> Vec<PlayerTrack> {
    let count = api
        .get_i64(handle, "track-list/count")
        .unwrap_or(0)
        .clamp(0, 256);
    (0..count)
        .filter_map(|index| {
            let prefix = format!("track-list/{index}");
            let kind = api.get_string(handle, &format!("{prefix}/type"))?;
            if !matches!(kind.as_str(), "audio" | "sub") {
                return None;
            }
            let is_subtitle = kind == "sub";
            let codec = api.get_string(handle, &format!("{prefix}/codec"));
            let language = api.get_string(handle, &format!("{prefix}/lang"));
            Some(PlayerTrack {
                id: api.get_i64(handle, &format!("{prefix}/id"))?,
                kind: if is_subtitle { "subtitle".into() } else { kind },
                title: api.get_string(handle, &format!("{prefix}/title")),
                friendly_language: language.as_deref().map(friendly_language_name),
                language,
                friendly_codec: codec.as_deref().map(|value| {
                    if is_subtitle {
                        friendly_subtitle_name(value)
                    } else {
                        friendly_codec_name(value)
                    }
                }),
                codec,
                selected: api
                    .get_flag(handle, &format!("{prefix}/selected"))
                    .unwrap_or(false),
                default: api
                    .get_flag(handle, &format!("{prefix}/default"))
                    .unwrap_or(false),
                forced: api
                    .get_flag(handle, &format!("{prefix}/forced"))
                    .unwrap_or(false),
                external: api
                    .get_flag(handle, &format!("{prefix}/external"))
                    .unwrap_or(false),
                channels: api.get_string(handle, &format!("{prefix}/audio-channels")),
                channel_layout: api.get_string(handle, &format!("{prefix}/demux-channels")),
                sample_rate: api.get_i64(handle, &format!("{prefix}/audio-samplerate")),
            })
        })
        .collect()
}

fn emit_state(app: &AppHandle, session_id: &str, state: &PlayerSnapshot) {
    let mut payload = serde_json::to_value(state).unwrap_or_else(|_| json!({}));
    if let Some(object) = payload.as_object_mut() {
        object.insert("sessionId".to_string(), json!(session_id));
    }
    let _ = app.emit("player:state", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_backend_modes_keep_strict_d3d11_and_explicit_wgl_separate() {
        assert_eq!(
            windows_backends("auto").unwrap(),
            vec![Backend::D3d11, Backend::RenderApi]
        );
        assert_eq!(windows_backends("d3d11").unwrap(), vec![Backend::D3d11]);
        assert_eq!(windows_backends("wgl").unwrap(), vec![Backend::RenderApi]);
        assert!(windows_backends("vulkan").is_err());
    }

    #[test]
    fn player_snapshot_defaults_are_stable() {
        let state = PlayerSnapshot::default();
        assert_eq!(state.status, "idle");
        assert!(state.tracks.is_empty());
        assert_eq!(state.volume, 1.0);
    }

    #[test]
    fn geometry_defaults_to_one_x_scale() {
        let geometry: PlayerGeometry =
            serde_json::from_value(json!({"x":1,"y":2,"width":640,"height":360})).unwrap();
        assert_eq!(geometry.scale_factor, 1.0);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert_eq!(geometry.border_radius, 0.0);
        assert_eq!(geometry.subtitle_position, 100.0);
    }

    #[test]
    fn lifecycle_rejects_commands_until_ready_and_while_closing() {
        assert!(!PlayerLifecycle::Opening.accepts_commands());
        assert!(PlayerLifecycle::Ready.accepts_commands());
        assert!(PlayerLifecycle::Playing.accepts_commands());
        assert!(PlayerLifecycle::Paused.accepts_commands());
        assert!(!PlayerLifecycle::Closing.accepts_commands());
        assert!(!PlayerLifecycle::Error.accepts_commands());
        assert!(!PlayerLifecycle::Closed.accepts_commands());
    }

    #[test]
    fn stale_close_never_matches_a_new_session() {
        assert!(is_target_session(Some("player-a"), "player-a"));
        assert!(!is_target_session(Some("player-b"), "player-a"));
        assert!(!is_target_session(None, "player-a"));
    }

    #[test]
    fn classifies_hdr10_hlg_and_dolby_vision_independently() {
        assert_eq!(
            classify_hdr_source(Some("pq"), Some("bt.2020"), None),
            (true, Some("HDR10 / PQ".to_string()))
        );
        assert_eq!(
            classify_hdr_source(Some("hlg"), Some("bt.2020"), None),
            (true, Some("HLG".to_string()))
        );
        assert_eq!(
            classify_hdr_source(Some("pq"), Some("bt.2020"), Some(8)),
            (true, Some("Dolby Vision profile 8".to_string()))
        );
        assert_eq!(
            classify_hdr_source(Some("gamma2.2"), Some("bt.709"), None),
            (false, None)
        );
    }

    #[test]
    fn detects_common_high_bit_depth_pixel_formats() {
        assert_eq!(detect_bit_depth(Some("yuv420p10le"), None), Some(10));
        assert_eq!(detect_bit_depth(Some("p010"), None), Some(10));
        assert_eq!(detect_bit_depth(Some("yuv444p12le"), None), Some(12));
        assert_eq!(
            detect_bit_depth(Some("videotoolbox"), Some("Main 10")),
            Some(10)
        );
        assert_eq!(detect_bit_depth(Some("yuv420p"), None), Some(8));
    }

    #[test]
    fn exposes_friendly_codec_names_outside_the_vue_layer() {
        assert_eq!(friendly_codec_name("eac3"), "Dolby Digital Plus");
        assert_eq!(friendly_codec_name("ac3"), "Dolby Digital");
        assert_eq!(friendly_codec_name("truehd"), "Dolby TrueHD");
        assert_eq!(friendly_codec_name("h264"), "AVC / H.264");
        assert_eq!(friendly_codec_name("custom"), "custom");
    }

    #[test]
    fn exposes_human_friendly_container_subtitle_language_and_color_names() {
        assert_eq!(friendly_container_name("mkv"), "Matroska");
        assert_eq!(friendly_subtitle_name("subrip"), "SubRip / SRT");
        assert_eq!(friendly_language_name("ru"), "Russian");
        assert_eq!(friendly_color_name("bt.709"), "BT.709");
        assert_eq!(friendly_color_name("bt.1886"), "BT.1886");
    }

    #[test]
    fn source_chroma_never_presents_nv12_as_compressed_signal_metadata() {
        assert_eq!(chroma_subsampling(Some("nv12")), None);
        assert_eq!(
            source_chroma_subsampling(Some("nv12"), Some("h264"), Some("High")),
            Some("YUV 4:2:0".to_string())
        );
    }

    #[test]
    fn derives_human_readable_chroma_subsampling() {
        assert_eq!(
            chroma_subsampling(Some("yuv420p")),
            Some("YUV 4:2:0".into())
        );
        assert_eq!(
            chroma_subsampling(Some("yuv422p10le")),
            Some("YUV 4:2:2".into())
        );
        assert_eq!(chroma_subsampling(Some("gbrp")), Some("RGB 4:4:4".into()));
        assert_eq!(chroma_subsampling(Some("nv12")), None);
    }

    #[test]
    fn display_capability_changes_switch_hdr_output_without_mislabeling_fallback() {
        let mut display = DisplayCapabilities {
            platform: "macos".to_string(),
            hdr_capable: true,
            hdr_enabled: true,
            output_supported: true,
            current_headroom: 4.0,
            potential_headroom: 8.0,
            ..DisplayCapabilities::default()
        };
        assert!(is_hdr_output_active(true, &display));
        display.current_headroom = 1.0;
        display.hdr_enabled = false;
        assert!(!is_hdr_output_active(true, &display));
        display.current_headroom = 4.0;
        display.hdr_enabled = true;
        display.output_supported = false;
        assert!(!is_hdr_output_active(true, &display));
    }

    #[test]
    fn dolby_vision_profile_seven_does_not_claim_fel_reconstruction() {
        let status = dolby_vision_support(7);
        assert!(status.contains("not claimed"));
        assert!(status.contains("MEL/FEL"));
    }
}
