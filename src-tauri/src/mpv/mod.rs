mod dynamic_library;
mod player;
mod render;
mod stream;
mod surface;

use serde::Serialize;
use std::{
    ffi::{c_char, c_double, c_int, c_void, CStr, CString},
    path::{Path, PathBuf},
};

use self::stream::MpvStreamOpenFn;
use dynamic_library::DynamicLibrary;
pub use player::{MpvPlayerManager, PlayerGeometry, PlayerSnapshot};

pub(crate) type MpvHandle = c_void;
pub(crate) type MpvRenderContext = c_void;

pub(crate) const MPV_FORMAT_FLAG: c_int = 3;
pub(crate) const MPV_FORMAT_INT64: c_int = 4;
pub(crate) const MPV_FORMAT_DOUBLE: c_int = 5;
pub(crate) const MPV_EVENT_NONE: c_int = 0;
pub(crate) const MPV_EVENT_SHUTDOWN: c_int = 1;
pub(crate) const MPV_EVENT_END_FILE: c_int = 7;
pub(crate) const MPV_EVENT_FILE_LOADED: c_int = 8;

#[repr(C)]
pub(crate) struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    playlist_entry_id: i64,
    playlist_insert_id: i64,
    playlist_insert_num_entries: c_int,
}

pub(crate) struct MpvEventDetails {
    pub event_id: c_int,
    pub error: c_int,
    pub end_file_error: c_int,
}

type MpvCreate = unsafe extern "C" fn() -> *mut MpvHandle;
type MpvInitialize = unsafe extern "C" fn(*mut MpvHandle) -> c_int;
type MpvSetOptionString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvSetPropertyString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvGetProperty =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type MpvGetPropertyString = unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> *mut c_char;
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvCommand = unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> c_int;
type MpvWaitEvent = unsafe extern "C" fn(*mut MpvHandle, c_double) -> *mut MpvEvent;
type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut MpvHandle);
type MpvClientApiVersion = unsafe extern "C" fn() -> u64;
type MpvStreamAdd =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *mut c_void, MpvStreamOpenFn) -> c_int;

pub(crate) type MpvRenderContextCreate = unsafe extern "C" fn(
    *mut *mut MpvRenderContext,
    *mut MpvHandle,
    *mut render::MpvRenderParam,
) -> c_int;
pub(crate) type MpvRenderContextSetUpdateCallback = unsafe extern "C" fn(
    *mut MpvRenderContext,
    Option<unsafe extern "C" fn(*mut c_void)>,
    *mut c_void,
);
pub(crate) type MpvRenderContextUpdate = unsafe extern "C" fn(*mut MpvRenderContext) -> u64;
pub(crate) type MpvRenderContextRender =
    unsafe extern "C" fn(*mut MpvRenderContext, *mut render::MpvRenderParam) -> c_int;
pub(crate) type MpvRenderContextReportSwap = unsafe extern "C" fn(*mut MpvRenderContext);
pub(crate) type MpvRenderContextFree = unsafe extern "C" fn(*mut MpvRenderContext);

pub(crate) struct MpvApi {
    _library: DynamicLibrary,
    create: MpvCreate,
    initialize: MpvInitialize,
    set_option_string: MpvSetOptionString,
    set_property_string: MpvSetPropertyString,
    get_property: MpvGetProperty,
    get_property_string: MpvGetPropertyString,
    free: MpvFree,
    command_fn: MpvCommand,
    wait_event_fn: MpvWaitEvent,
    error_string_fn: MpvErrorString,
    terminate_destroy: MpvTerminateDestroy,
    client_api_version: MpvClientApiVersion,
    stream_add: MpvStreamAdd,
    pub(crate) render_context_create: MpvRenderContextCreate,
    pub(crate) render_context_set_update_callback: MpvRenderContextSetUpdateCallback,
    pub(crate) render_context_update: MpvRenderContextUpdate,
    pub(crate) render_context_render: MpvRenderContextRender,
    pub(crate) render_context_report_swap: MpvRenderContextReportSwap,
    pub(crate) render_context_free: MpvRenderContextFree,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvCapabilities {
    pub available: bool,
    pub library_path: Option<String>,
    pub client_api_version: Option<u64>,
    pub custom_stream: bool,
    pub render_api: bool,
    pub reason: Option<String>,
}

impl MpvApi {
    pub(crate) fn load_bundled() -> Result<Self, String> {
        let candidates = bundled_candidates();
        let path = candidates
            .iter()
            .find(|path| path.is_file())
            .ok_or_else(|| {
                format!(
                    "Bundled libmpv was not found (checked {})",
                    candidates
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
        unsafe { Self::load(path) }
    }

    unsafe fn load(path: &Path) -> Result<Self, String> {
        let library = unsafe { DynamicLibrary::open(path) }?;
        macro_rules! symbol {
            ($name:literal, $kind:ty) => {{
                unsafe { library.symbol::<$kind>($name) }
                    .map_err(|error| format!("Missing libmpv symbol {}: {error}", $name))?
            }};
        }
        Ok(Self {
            create: symbol!("mpv_create", MpvCreate),
            initialize: symbol!("mpv_initialize", MpvInitialize),
            set_option_string: symbol!("mpv_set_option_string", MpvSetOptionString),
            set_property_string: symbol!("mpv_set_property_string", MpvSetPropertyString),
            get_property: symbol!("mpv_get_property", MpvGetProperty),
            get_property_string: symbol!("mpv_get_property_string", MpvGetPropertyString),
            free: symbol!("mpv_free", MpvFree),
            command_fn: symbol!("mpv_command", MpvCommand),
            wait_event_fn: symbol!("mpv_wait_event", MpvWaitEvent),
            error_string_fn: symbol!("mpv_error_string", MpvErrorString),
            terminate_destroy: symbol!("mpv_terminate_destroy", MpvTerminateDestroy),
            client_api_version: symbol!("mpv_client_api_version", MpvClientApiVersion),
            stream_add: symbol!("mpv_stream_cb_add_ro", MpvStreamAdd),
            render_context_create: symbol!("mpv_render_context_create", MpvRenderContextCreate),
            render_context_set_update_callback: symbol!(
                "mpv_render_context_set_update_callback",
                MpvRenderContextSetUpdateCallback
            ),
            render_context_update: symbol!("mpv_render_context_update", MpvRenderContextUpdate),
            render_context_render: symbol!("mpv_render_context_render", MpvRenderContextRender),
            render_context_report_swap: symbol!(
                "mpv_render_context_report_swap",
                MpvRenderContextReportSwap
            ),
            render_context_free: symbol!("mpv_render_context_free", MpvRenderContextFree),
            _library: library,
        })
    }

    pub fn capabilities() -> MpvCapabilities {
        match Self::load_bundled() {
            Ok(api) => MpvCapabilities {
                available: true,
                library_path: bundled_candidates()
                    .into_iter()
                    .find(|path| path.is_file())
                    .map(|path| path.display().to_string()),
                client_api_version: Some(unsafe { (api.client_api_version)() }),
                custom_stream: true,
                render_api: surface::SUPPORTED,
                reason: (!surface::SUPPORTED).then(|| {
                    "Native Render API surface is not implemented on this platform".to_string()
                }),
            },
            Err(reason) => MpvCapabilities {
                available: false,
                library_path: None,
                client_api_version: None,
                custom_stream: false,
                render_api: false,
                reason: Some(reason),
            },
        }
    }

    pub(crate) fn initialize_for_streams(
        &self,
        registry: *mut c_void,
    ) -> Result<*mut MpvHandle, String> {
        let handle = unsafe { (self.create)() };
        if handle.is_null() {
            return Err("mpv_create returned null".to_string());
        }
        let result = (|| {
            self.set_option(handle, "terminal", "no")?;
            self.set_option(handle, "config", "no")?;
            self.set_option(handle, "input-default-bindings", "no")?;
            self.set_option(handle, "input-vo-keyboard", "no")?;
            self.set_option(handle, "keep-open", "yes")?;
            self.set_option(handle, "idle", "yes")?;
            self.set_option(handle, "vo", "libmpv")?;
            #[cfg(target_os = "macos")]
            self.set_option(handle, "ao", "coreaudio,avfoundation")?;
            // The caller-owned OpenGL Render API cannot safely import every
            // platform-native hardware surface. Prefer VideoToolbox/D3D11VA
            // copy-back decoders, which retain hardware codec decoding while
            // presenting ordinary frames to the existing cross-platform
            // renderer. mpv falls back to software when no safe hwdec exists.
            self.set_option(handle, "hwdec", "auto-copy-safe")?;
            if let Some(log_path) = std::env::var_os("VESPERWIND_MPV_LOG") {
                self.set_option(handle, "log-file", &log_path.to_string_lossy())?;
                self.set_option(handle, "msg-level", "all=v")?;
            }
            #[cfg(target_os = "macos")]
            {
                // Keep intermediate video processing in floating point. The final
                // target transfer/peak is updated from the active NSScreen.
                self.set_option(handle, "fbo-format", "rgba16f")?;
                self.set_option(handle, "hdr-compute-peak", "yes")?;
                self.set_option(handle, "tone-mapping", "bt.2390")?;
            }
            self.set_option(handle, "sub-auto", "fuzzy")?;
            self.set_option(handle, "sub-font-provider", "auto")?;
            let protocol = CString::new("vesperwind").unwrap();
            let status = unsafe {
                (self.stream_add)(handle, protocol.as_ptr(), registry, stream::open_stream)
            };
            if status < 0 {
                return Err(format!("mpv_stream_cb_add_ro failed with {status}"));
            }
            let status = unsafe { (self.initialize)(handle) };
            if status < 0 {
                return Err(format!("mpv_initialize failed with {status}"));
            }
            Ok(handle)
        })();
        if result.is_err() {
            unsafe { (self.terminate_destroy)(handle) };
        }
        result
    }

    pub(crate) fn destroy(&self, handle: *mut MpvHandle) {
        if !handle.is_null() {
            unsafe { (self.terminate_destroy)(handle) };
        }
    }

    fn set_option(&self, handle: *mut MpvHandle, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|error| error.to_string())?;
        let value = CString::new(value).map_err(|error| error.to_string())?;
        status(
            unsafe { (self.set_option_string)(handle, name.as_ptr(), value.as_ptr()) },
            "mpv_set_option_string",
        )
    }

    pub(crate) fn set_property(
        &self,
        handle: *mut MpvHandle,
        name: &str,
        value: &str,
    ) -> Result<(), String> {
        let name = CString::new(name).map_err(|error| error.to_string())?;
        let value = CString::new(value).map_err(|error| error.to_string())?;
        status(
            unsafe { (self.set_property_string)(handle, name.as_ptr(), value.as_ptr()) },
            "mpv_set_property_string",
        )
    }

    pub(crate) fn command(&self, handle: *mut MpvHandle, arguments: &[&str]) -> Result<(), String> {
        let values = arguments
            .iter()
            .map(|value| CString::new(*value).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers = values
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        pointers.push(std::ptr::null());
        status(
            unsafe { (self.command_fn)(handle, pointers.as_ptr()) },
            "mpv_command",
        )
    }

    pub(crate) fn get_string(&self, handle: *mut MpvHandle, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let value = unsafe { (self.get_property_string)(handle, name.as_ptr()) };
        if value.is_null() {
            return None;
        }
        let result = unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.free)(value.cast()) };
        Some(result)
    }

    pub(crate) fn get_double(&self, handle: *mut MpvHandle, name: &str) -> Option<f64> {
        let name = CString::new(name).ok()?;
        let mut value = 0.0_f64;
        (unsafe {
            (self.get_property)(
                handle,
                name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        } >= 0)
            .then_some(value)
    }

    pub(crate) fn get_i64(&self, handle: *mut MpvHandle, name: &str) -> Option<i64> {
        let name = CString::new(name).ok()?;
        let mut value = 0_i64;
        (unsafe {
            (self.get_property)(
                handle,
                name.as_ptr(),
                MPV_FORMAT_INT64,
                (&mut value as *mut i64).cast(),
            )
        } >= 0)
            .then_some(value)
    }

    pub(crate) fn get_flag(&self, handle: *mut MpvHandle, name: &str) -> Option<bool> {
        let name = CString::new(name).ok()?;
        let mut value = 0_i32;
        (unsafe {
            (self.get_property)(
                handle,
                name.as_ptr(),
                MPV_FORMAT_FLAG,
                (&mut value as *mut i32).cast(),
            )
        } >= 0)
            .then_some(value != 0)
    }

    pub(crate) fn wait_event_details(
        &self,
        handle: *mut MpvHandle,
        seconds: f64,
    ) -> MpvEventDetails {
        let event = unsafe { (self.wait_event_fn)(handle, seconds) };
        if event.is_null() {
            return MpvEventDetails {
                event_id: MPV_EVENT_NONE,
                error: 0,
                end_file_error: 0,
            };
        }
        let event = unsafe { &*event };
        let end_file_error = if event.event_id == MPV_EVENT_END_FILE && !event.data.is_null() {
            unsafe { (*(event.data as *const MpvEventEndFile)).error }
        } else {
            0
        };
        MpvEventDetails {
            event_id: event.event_id,
            error: event.error,
            end_file_error,
        }
    }

    pub(crate) fn error_string(&self, code: c_int) -> String {
        let value = unsafe { (self.error_string_fn)(code) };
        if value.is_null() {
            format!("libmpv error {code}")
        } else {
            unsafe { CStr::from_ptr(value) }
                .to_string_lossy()
                .into_owned()
        }
    }
}

fn status(value: c_int, operation: &str) -> Result<(), String> {
    (value >= 0)
        .then_some(())
        .ok_or_else(|| format!("{operation} failed with {value}"))
}

fn bundled_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("VESPERWIND_LIBMPV_PATH") {
        candidates.push(PathBuf::from(path));
    }
    #[cfg(all(debug_assertions, target_os = "macos"))]
    candidates
        .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/libmpv/macos/libmpv.2.dylib"));
    #[cfg(all(debug_assertions, target_os = "windows"))]
    candidates
        .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/libmpv/windows/mpv-2.dll"));
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            #[cfg(target_os = "macos")]
            {
                candidates.push(directory.join("../Frameworks/libmpv.2.dylib"));
                candidates.push(directory.join("../Resources/vendor/libmpv/macos/libmpv.2.dylib"));
            }
            #[cfg(target_os = "windows")]
            {
                candidates.push(directory.join("mpv-2.dll"));
                candidates.push(directory.join("libmpv-2.dll"));
                candidates.push(directory.join("resources/vendor/libmpv/windows/mpv-2.dll"));
            }
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::{stream, MpvApi, MPV_EVENT_END_FILE, MPV_EVENT_FILE_LOADED};

    #[cfg(target_os = "macos")]
    use crate::{filesystem::Filesystem, provider_content::ContentSource, ssh::SshManager};

    #[cfg(target_os = "macos")]
    use std::{
        ffi::CString,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };

    #[test]
    fn runtime_never_falls_back_to_an_external_mpv_process() {
        let capabilities = MpvApi::capabilities();
        #[cfg(target_os = "macos")]
        assert!(capabilities.available, "{:?}", capabilities.reason);
        if std::env::var_os("VESPERWIND_LIBMPV_PATH").is_some() {
            assert!(capabilities.available, "{:?}", capabilities.reason);
            assert!(capabilities.client_api_version.is_some());
            assert!(capabilities.custom_stream);
        }
        if capabilities.available {
            assert_eq!(
                capabilities.render_api,
                cfg!(any(target_os = "macos", target_os = "windows"))
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundled_libmpv_accepts_the_edr_render_configuration() {
        let api = MpvApi::load_bundled().expect("bundled libmpv");
        let handle = unsafe { (api.create)() };
        assert!(!handle.is_null());
        for (name, value) in [
            ("terminal", "no"),
            ("config", "no"),
            ("idle", "yes"),
            ("fbo-format", "rgba16f"),
            ("hdr-compute-peak", "yes"),
            ("tone-mapping", "bt.2390"),
        ] {
            api.set_option(handle, name, value)
                .unwrap_or_else(|error| panic!("{name}={value}: {error}"));
        }
        assert!(unsafe { (api.initialize)(handle) } >= 0);
        for (name, value) in [
            ("target-trc", "linear"),
            ("target-prim", "display-p3"),
            ("target-peak", "812"),
        ] {
            api.set_property(handle, name, value)
                .unwrap_or_else(|error| panic!("{name}={value}: {error}"));
        }
        api.destroy(handle);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "manual real-file smoke test; set VESPERWIND_MPV_SMOKE_FILE"]
    fn bundled_libmpv_decodes_a_real_provider_stream() {
        let path = PathBuf::from(
            std::env::var_os("VESPERWIND_MPV_SMOKE_FILE")
                .expect("set VESPERWIND_MPV_SMOKE_FILE to a local media file"),
        );
        let parent = path.parent().expect("media parent");
        let root = dirs::home_dir()
            .filter(|home| path.starts_with(home))
            .unwrap_or_else(|| parent.to_path_buf());
        let filesystem = Filesystem::from_root(&root, root.clone()).expect("filesystem");
        let cycles = std::env::var("VESPERWIND_MPV_SMOKE_CYCLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1)
            .max(1);
        for cycle in 1..=cycles {
            let ssh = SshManager::new();
            let source =
                ContentSource::open(&filesystem, &ssh, Some("local"), &path.to_string_lossy())
                    .expect("content source");
            let registry = stream::MpvStreamRegistry::new(ssh);
            let uri = registry.register(source);
            let api = MpvApi::load_bundled().expect("bundled libmpv");
            let handle = unsafe { (api.create)() };
            assert!(!handle.is_null());

            for (name, value) in [
                ("terminal", "no"),
                ("config", "no"),
                ("idle", "yes"),
                ("vo", "null"),
                ("volume", "0"),
                ("hwdec", "auto-copy-safe"),
            ] {
                api.set_option(handle, name, value).expect(name);
            }
            #[cfg(target_os = "macos")]
            api.set_option(handle, "ao", "coreaudio,avfoundation")
                .expect("ordered macOS audio outputs");
            if let Ok(output) = std::env::var("VESPERWIND_MPV_SMOKE_AO") {
                api.set_option(handle, "ao", &output).expect("ao");
            }
            if let Some(log_path) = std::env::var_os("VESPERWIND_MPV_SMOKE_LOG") {
                api.set_option(handle, "log-file", &log_path.to_string_lossy())
                    .expect("log-file");
                api.set_option(handle, "msg-level", "all=v")
                    .expect("msg-level");
            }
            let protocol = CString::new("vesperwind").unwrap();
            assert!(
                unsafe {
                    (api.stream_add)(
                        handle,
                        protocol.as_ptr(),
                        Arc::as_ptr(&registry).cast_mut().cast(),
                        stream::open_stream,
                    )
                } >= 0
            );
            assert!(unsafe { (api.initialize)(handle) } >= 0);
            api.command(handle, &["loadfile", &uri, "replace"])
                .expect("loadfile");

            let deadline = Instant::now() + Duration::from_secs(15);
            let mut loaded = false;
            let mut progressed = false;
            let mut playback_started = None;
            let mut media_start = 0.0;
            let mut media_time = 0.0;
            while Instant::now() < deadline {
                match api.wait_event_details(handle, 0.05).event_id {
                    MPV_EVENT_FILE_LOADED => {
                        loaded = true;
                        media_start = api.get_double(handle, "time-pos").unwrap_or_default();
                        api.set_property(handle, "pause", "no").expect("play");
                        playback_started = Some(Instant::now());
                    }
                    MPV_EVENT_END_FILE if !progressed => break,
                    _ => {}
                }
                media_time = api.get_double(handle, "time-pos").unwrap_or_default();
                progressed = media_time > 0.1;
                if playback_started
                    .is_some_and(|started| started.elapsed() >= Duration::from_secs(2))
                {
                    break;
                }
            }

            let duration = api.get_double(handle, "duration").unwrap_or_default();
            let tracks = api.get_i64(handle, "track-list/count").unwrap_or_default();
            let initial_ao = api.get_string(handle, "current-ao");
            let current_vo = api.get_string(handle, "current-vo");
            let audio_codec = api.get_string(handle, "current-tracks/audio/codec");
            let hardware_decoder = api.get_string(handle, "hwdec-current");
            let video_width = api.get_i64(handle, "video-params/w").unwrap_or_default();
            let video_height = api.get_i64(handle, "video-params/h").unwrap_or_default();
            eprintln!(
            "mpv smoke cycle {cycle}/{cycles}: media_delta={:.2}s ao={initial_ao:?} vo={current_vo:?} audio={audio_codec:?} hwdec-current={hardware_decoder:?}",
            media_time - media_start,
        );

            let expected_audio_codecs = std::env::var("VESPERWIND_MPV_EXPECT_AUDIO_CODECS")
                .ok()
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for expected_codec in expected_audio_codecs {
                let audio_track = (0..tracks).find_map(|index| {
                    let prefix = format!("track-list/{index}");
                    (api.get_string(handle, &format!("{prefix}/type")).as_deref() == Some("audio")
                        && api
                            .get_string(handle, &format!("{prefix}/codec"))
                            .as_deref()
                            == Some(expected_codec.as_str()))
                    .then(|| api.get_i64(handle, &format!("{prefix}/id")))
                    .flatten()
                });
                let track_id = audio_track.unwrap_or_else(|| {
                    panic!("real MKV has no expected {expected_codec} audio track")
                });
                api.set_property(handle, "aid", &track_id.to_string())
                    .expect("switch audio track");

                let switch_deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < switch_deadline
                    && api
                        .get_string(handle, "current-tracks/audio/codec")
                        .as_deref()
                        != Some(expected_codec.as_str())
                {
                    api.wait_event_details(handle, 0.05);
                }
                assert_eq!(
                    api.get_string(handle, "current-tracks/audio/codec")
                        .as_deref(),
                    Some(expected_codec.as_str()),
                    "audio track switch did not become active"
                );
                let audio_channels = api.get_string(handle, "current-tracks/audio/demux-channels");
                let audio_sample_rate =
                    api.get_i64(handle, "current-tracks/audio/demux-samplerate");
                let audio_bitrate = api.get_i64(handle, "current-tracks/audio/demux-bitrate");
                eprintln!(
                    "audio metadata: channels={audio_channels:?} sample_rate={audio_sample_rate:?} bitrate={audio_bitrate:?}"
                );
                assert!(audio_channels.is_some(), "audio channel layout is missing");
                assert!(
                    audio_sample_rate.is_some_and(|rate| rate > 0),
                    "audio sample rate is missing"
                );
                assert!(
                    audio_bitrate.is_some_and(|rate| rate > 0),
                    "audio bitrate is missing"
                );

                let wall_start = Instant::now();
                let media_before = api.get_double(handle, "time-pos").unwrap_or_default();
                while wall_start.elapsed() < Duration::from_millis(1200) {
                    api.wait_event_details(handle, 0.05);
                }
                let media_after = api.get_double(handle, "time-pos").unwrap_or_default();
                let wall_delta = wall_start.elapsed().as_secs_f64();
                let media_delta = media_after - media_before;
                let avsync = api.get_double(handle, "avsync").unwrap_or_default();
                eprintln!(
                    "audio switch: codec={expected_codec} aid={track_id} media_delta={media_delta:.3}s wall_delta={wall_delta:.3}s avsync={avsync:.4}s"
                );
                assert!(
                    (media_delta - wall_delta).abs() < 0.5,
                    "{expected_codec} playback is not realtime: media={media_delta:.3}s wall={wall_delta:.3}s"
                );
                assert!(
                    avsync.abs() < 0.25,
                    "{expected_codec} A/V sync drift is too large: {avsync:.4}s"
                );
            }
            let current_ao = api.get_string(handle, "current-ao");
            eprintln!("audio output after track switches: {current_ao:?}");
            api.command(handle, &["stop"]).ok();
            api.destroy(handle);
            registry.remove(&uri);

            assert!(loaded, "libmpv did not load the provider stream");
            assert!(duration > 0.0, "libmpv did not expose media duration");
            assert!(tracks > 0, "libmpv did not expose media tracks");
            assert!(
                video_width > 0 && video_height > 0,
                "libmpv did not decode video parameters"
            );
            assert!(progressed, "libmpv did not decode beyond the first frame");
            if let Ok(expected) = std::env::var("VESPERWIND_MPV_EXPECT_HWDEC") {
                assert_eq!(hardware_decoder.as_deref(), Some(expected.as_str()));
            }
            if let Ok(expected) = std::env::var("VESPERWIND_MPV_EXPECT_AUDIO_OUTPUT") {
                assert_eq!(current_ao.as_deref(), Some(expected.as_str()));
            }
            assert!(
                media_time - media_start < 5.0,
                "libmpv playback clock ran too fast: {:.2}s in 2s wall time",
                media_time - media_start
            );
        }
    }
}
