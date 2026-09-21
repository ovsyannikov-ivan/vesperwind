use super::{
    render::Renderer,
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
use tauri::{AppHandle, Emitter, WebviewWindow};

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
    pub viewport_height: Option<f64>,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerTrack {
    pub id: i64,
    pub kind: String,
    pub title: Option<String>,
    pub language: Option<String>,
    pub codec: Option<String>,
    pub selected: bool,
    pub default: bool,
    pub forced: bool,
    pub external: bool,
    pub channels: Option<String>,
    pub sample_rate: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
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
    pub container: Option<String>,
    pub file_size: Option<i64>,
    pub duration: Option<f64>,
    pub overall_bitrate: Option<f64>,
    pub video: VideoDiagnostics,
    pub audio: AudioDiagnostics,
    pub subtitle: SubtitleDiagnostics,
    pub source_hdr: bool,
    pub source_format: Option<String>,
    pub transfer: Option<String>,
    pub primaries: Option<String>,
    pub pixel_format: Option<String>,
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
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub codec: Option<String>,
    pub friendly_codec: Option<String>,
    pub bitrate: Option<f64>,
    pub channels: Option<String>,
    pub sample_rate: Option<i64>,
    pub language: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleDiagnostics {
    pub format: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: Option<bool>,
    pub forced: Option<bool>,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
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
    Snapshot(mpsc::SyncSender<Result<PlayerSnapshot, String>>),
    Shutdown(mpsc::SyncSender<()>),
}

struct RunningPlayer {
    sender: mpsc::Sender<Control>,
    surface: NativeSurface,
    thread: Option<JoinHandle<()>>,
}

pub struct MpvPlayerManager {
    ssh: Arc<SshManager>,
    registry: Arc<MpvStreamRegistry>,
    running: Mutex<Option<RunningPlayer>>,
    overlay_context: Mutex<Value>,
}

impl MpvPlayerManager {
    pub fn new(ssh: Arc<SshManager>) -> Arc<Self> {
        Arc::new(Self {
            registry: MpvStreamRegistry::new(Arc::clone(&ssh)),
            ssh,
            running: Mutex::new(None),
            overlay_context: Mutex::new(json!({})),
        })
    }

    fn ensure_started(&self, window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if running.is_some() {
            return Ok(());
        }
        let api = Arc::new(MpvApi::load_bundled()?);
        let handle = api.initialize_for_streams(Arc::as_ptr(&self.registry).cast_mut().cast())?;
        let surface = match NativeSurface::create(window) {
            Ok(surface) => surface,
            Err(error) => {
                api.destroy(handle);
                return Err(error);
            }
        };
        surface.refresh_display_capabilities();
        let display = surface.display_capabilities();
        if let Err(error) = configure_display_output(&api, handle, &display) {
            api.destroy(handle);
            return Err(error);
        }
        let renderer = match Renderer::start(Arc::clone(&api), handle, surface.clone()) {
            Ok(renderer) => renderer,
            Err(error) => {
                api.destroy(handle);
                return Err(error);
            }
        };
        let (sender, receiver) = mpsc::channel();
        let handle_address = handle as usize;
        let registry = Arc::clone(&self.registry);
        let control_surface = surface.clone();
        let app = app.clone();
        let thread = thread::Builder::new()
            .name("vesperwind-mpv-control".to_string())
            .spawn(move || {
                control_loop(
                    api,
                    handle_address,
                    renderer,
                    registry,
                    control_surface,
                    receiver,
                    app,
                )
            })
            .map_err(|error| error.to_string())?;
        *running = Some(RunningPlayer {
            sender,
            surface,
            thread: Some(thread),
        });
        Ok(())
    }

    pub fn open(
        &self,
        filesystem: &Filesystem,
        window: &WebviewWindow,
        app: &AppHandle,
        provider_id: Option<&str>,
        path: &str,
        autoplay: bool,
        geometry: PlayerGeometry,
    ) -> Result<PlayerSnapshot, String> {
        let source = ContentSource::open(filesystem, &self.ssh, provider_id, path)
            .map_err(|error| error.message)?;
        self.ensure_started(window, app)?;
        let uri = self.registry.register(source);
        let result = self.with_running(|running| {
            running.surface.set_geometry(geometry)?;
            running.surface.set_visible(true)?;
            request(&running.sender, |reply| Control::Load {
                uri: uri.clone(),
                autoplay,
                reply,
            })
        });
        if result.is_err() {
            self.registry.remove(&uri);
        }
        result
    }

    pub fn set_geometry(&self, geometry: PlayerGeometry) -> Result<(), String> {
        self.with_running(|running| running.surface.set_geometry(geometry))
    }

    pub fn set_overlay_context(&self, context: Value) {
        *self
            .overlay_context
            .lock()
            .unwrap_or_else(|value| value.into_inner()) = context;
    }

    pub fn overlay_context(&self) -> Value {
        self.overlay_context
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    pub fn play(&self) -> Result<PlayerSnapshot, String> {
        self.with_request(Control::Play)
    }
    pub fn pause(&self) -> Result<PlayerSnapshot, String> {
        self.with_request(Control::Pause)
    }
    pub fn snapshot(&self) -> Result<PlayerSnapshot, String> {
        self.with_request(Control::Snapshot)
    }
    pub fn seek(&self, seconds: f64) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| {
            request(&running.sender, |reply| Control::Seek { seconds, reply })
        })
    }
    pub fn set_volume(&self, volume: f64) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| {
            request(&running.sender, |reply| Control::SetVolume {
                volume,
                reply,
            })
        })
    }
    pub fn set_muted(&self, muted: bool) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| {
            request(&running.sender, |reply| Control::SetMuted { muted, reply })
        })
    }
    pub fn select_track(&self, kind: String, id: Option<i64>) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| {
            request(&running.sender, |reply| Control::SelectTrack {
                kind,
                id,
                reply,
            })
        })
    }
    pub fn set_subtitle_delay(&self, seconds: f64) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| {
            request(&running.sender, |reply| Control::SetSubtitleDelay {
                seconds,
                reply,
            })
        })
    }

    fn with_request(
        &self,
        constructor: fn(mpsc::SyncSender<Result<PlayerSnapshot, String>>) -> Control,
    ) -> Result<PlayerSnapshot, String> {
        self.with_running(|running| request(&running.sender, constructor))
    }

    fn with_running<T>(
        &self,
        operation: impl FnOnce(&RunningPlayer) -> Result<T, String>,
    ) -> Result<T, String> {
        let running = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        operation(
            running
                .as_ref()
                .ok_or_else(|| "The native player is not open".to_string())?,
        )
    }

    pub fn close(&self) {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .take();
        if let Some(mut running) = running.take() {
            let _ = running.surface.set_visible(false);
            let (reply, finished) = mpsc::sync_channel(1);
            let _ = running.sender.send(Control::Shutdown(reply));
            let _ = finished.recv_timeout(Duration::from_secs(5));
            if let Some(thread) = running.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for MpvPlayerManager {
    fn drop(&mut self) {
        self.close();
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
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "The native player did not respond".to_string())?
}

fn control_loop(
    api: Arc<MpvApi>,
    handle_address: usize,
    renderer: Renderer,
    registry: Arc<MpvStreamRegistry>,
    surface: NativeSurface,
    receiver: mpsc::Receiver<Control>,
    app: AppHandle,
) {
    let handle = handle_address as *mut MpvHandle;
    let mut current_uri: Option<String> = None;
    let mut state = PlayerSnapshot::default();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_display_refresh = Instant::now() - Duration::from_secs(1);
    let mut display = surface.display_capabilities();
    let mut shutdown_reply = None;
    'running: loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Control::Load {
                uri,
                autoplay,
                reply,
            }) => {
                state.status = "loading".to_string();
                state.error = None;
                emit_state(&app, &state);
                let result = api
                    .command(handle, &["loadfile", &uri, "replace"])
                    .and_then(|_| {
                        api.set_property(handle, "pause", if autoplay { "no" } else { "yes" })
                    })
                    .map(|_| {
                        if let Some(previous) = current_uri.replace(uri) {
                            registry.remove(&previous);
                        }
                        read_snapshot(&api, handle, &state, &display)
                    });
                if let Ok(next) = &result {
                    state = next.clone();
                }
                let _ = reply.send(result);
            }
            Ok(Control::Play(reply)) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "pause", "no")
                })
            }
            Ok(Control::Pause(reply)) => {
                reply_with(&api, handle, &mut state, reply, |api, handle| {
                    api.set_property(handle, "pause", "yes")
                })
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
            Ok(Control::Snapshot(reply)) => {
                state = read_snapshot(&api, handle, &state, &display);
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
            let event = api.wait_event_details(handle, 0.0);
            match event.event_id {
                MPV_EVENT_NONE => break,
                MPV_EVENT_FILE_LOADED => {
                    state.status = if api.get_flag(handle, "pause").unwrap_or(false) {
                        "paused".into()
                    } else {
                        "playing".into()
                    };
                    state.error = None;
                    event_changed = true;
                }
                MPV_EVENT_END_FILE => {
                    let error = if event.end_file_error < 0 {
                        event.end_file_error
                    } else {
                        event.error
                    };
                    if error < 0 {
                        state.status = "error".into();
                        state.error = Some(format!(
                            "libmpv could not play this file: {}",
                            api.error_string(error)
                        ));
                    } else {
                        state.status = "ended".into();
                    }
                    event_changed = true;
                }
                MPV_EVENT_SHUTDOWN => break 'running,
                _ => {}
            }
        }
        if last_emit.elapsed() >= Duration::from_millis(100) {
            if last_display_refresh.elapsed() >= Duration::from_millis(500) {
                surface.refresh_display_capabilities();
                let next_display = surface.display_capabilities();
                if next_display != display {
                    let _ = configure_display_output(&api, handle, &next_display);
                    display = next_display;
                    event_changed = true;
                }
                last_display_refresh = Instant::now();
            }
            let next = read_snapshot(&api, handle, &state, &display);
            if next != state || event_changed {
                state = next;
                emit_state(&app, &state);
            }
            last_emit = Instant::now();
        }
    }

    let _ = api.command(handle, &["stop"]);
    if let Some(uri) = current_uri {
        registry.remove(&uri);
    }
    renderer.stop();
    api.destroy(handle);
    let _ = app.emit("player:state", json!({ "status": "closed" }));
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(());
    }
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
        tracks: read_tracks(api, handle),
        diagnostics: read_diagnostics(api, handle, display),
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

fn read_diagnostics(
    api: &MpvApi,
    handle: *mut MpvHandle,
    display: &DisplayCapabilities,
) -> PlaybackDiagnostics {
    let transfer = api.get_string(handle, "video-params/gamma");
    let primaries = api.get_string(handle, "video-params/primaries");
    let pixel_format = api.get_string(handle, "video-params/pixelformat");
    let codec_profile = api.get_string(handle, "current-tracks/video/codec-profile");
    let file_size = api.get_i64(handle, "file-size").filter(|value| *value > 0);
    let duration = api
        .get_double(handle, "duration")
        .filter(|value| *value > 0.0);
    let video_codec = api.get_string(handle, "current-tracks/video/codec");
    let audio_codec = api.get_string(handle, "current-tracks/audio/codec");
    let dolby_vision_profile = api.get_i64(handle, "current-tracks/video/dolby-vision-profile");
    let dolby_vision_level = api.get_i64(handle, "current-tracks/video/dolby-vision-level");
    let (source_hdr, source_format) = classify_hdr_source(
        transfer.as_deref(),
        primaries.as_deref(),
        dolby_vision_profile,
    );
    let output_hdr_active = is_hdr_output_active(source_hdr, display);
    let target_peak_nits =
        (display.platform == "macos").then_some(203.0 * display.current_headroom.max(1.0));
    let tone_mapping = if !source_hdr {
        "none".to_string()
    } else if output_hdr_active {
        "display-adaptive to current EDR headroom".to_string()
    } else {
        "HDR-to-SDR fallback".to_string()
    };
    let output_mode = if output_hdr_active {
        "HDR (macOS EDR)".to_string()
    } else if source_hdr {
        "SDR fallback".to_string()
    } else {
        "SDR".to_string()
    };
    let output_color_space = if display.platform == "macos" && display.hdr_capable {
        "linear Display P3".to_string()
    } else {
        "BT.709 / gamma 2.2".to_string()
    };
    let fallback_reason = (source_hdr && !output_hdr_active).then(|| {
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
    PlaybackDiagnostics {
        container: api.get_string(handle, "file-format"),
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
                .get_flag(handle, "video-params/interlaced")
                .map(|interlaced| !interlaced),
            bitrate: api
                .get_double(handle, "current-tracks/video/demux-bitrate")
                .filter(|value| *value > 0.0),
            chroma: chroma_subsampling(pixel_format.as_deref()),
            matrix: api.get_string(handle, "video-params/colormatrix"),
        },
        audio: AudioDiagnostics {
            friendly_codec: audio_codec.as_deref().map(friendly_codec_name),
            codec: audio_codec,
            bitrate: api
                .get_double(handle, "current-tracks/audio/demux-bitrate")
                .filter(|value| *value > 0.0),
            channels: api
                .get_string(handle, "current-tracks/audio/audio-channels")
                .or_else(|| api.get_string(handle, "audio-params/channel-count")),
            sample_rate: api
                .get_i64(handle, "current-tracks/audio/audio-samplerate")
                .or_else(|| api.get_i64(handle, "audio-params/samplerate"))
                .filter(|value| *value > 0),
            language: api.get_string(handle, "current-tracks/audio/lang"),
            title: api.get_string(handle, "current-tracks/audio/title"),
        },
        subtitle: SubtitleDiagnostics {
            format: api.get_string(handle, "current-tracks/sub/codec"),
            language: api.get_string(handle, "current-tracks/sub/lang"),
            title: api.get_string(handle, "current-tracks/sub/title"),
            default: api.get_flag(handle, "current-tracks/sub/default"),
            forced: api.get_flag(handle, "current-tracks/sub/forced"),
        },
        source_hdr,
        source_format,
        transfer,
        primaries,
        bit_depth: detect_bit_depth(pixel_format.as_deref(), codec_profile.as_deref()),
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
        renderer: "libmpv OpenGL Render API (vo=libmpv/vo_gpu)".to_string(),
        display: display.clone(),
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
    source_hdr && display.output_supported && display.hdr_enabled && display.current_headroom > 1.0
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
            Some(PlayerTrack {
                id: api.get_i64(handle, &format!("{prefix}/id"))?,
                kind: if kind == "sub" {
                    "subtitle".into()
                } else {
                    kind
                },
                title: api.get_string(handle, &format!("{prefix}/title")),
                language: api.get_string(handle, &format!("{prefix}/lang")),
                codec: api.get_string(handle, &format!("{prefix}/codec")),
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
                sample_rate: api.get_i64(handle, &format!("{prefix}/audio-samplerate")),
            })
        })
        .collect()
}

fn emit_state(app: &AppHandle, state: &PlayerSnapshot) {
    let _ = app.emit("player:state", state);
}

#[cfg(test)]
mod tests {
    use super::*;

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
