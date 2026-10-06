//! Thumbnail extraction is independent of playback. Only application-owned
//! FFmpeg is resolved; neither PATH nor a user-configurable executable is used.
use crate::{
    error::NativeError,
    filesystem::{paths, Filesystem},
    mpv::PlaybackDiagnostics,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const MAX_IMAGE: usize = 512 * 1024;
const MAX_LOG: usize = 128 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    pub path: String,
    pub time: f64,
    pub width: u32,
    pub provider_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub cancel: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time: Option<f64>,
}
impl Thumbnail {
    pub fn unavailable(reason: &'static str) -> Self {
        Self {
            status: "unavailable",
            reason: Some(reason),
            url: None,
            time: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColorPolicy {
    Sdr,
    ToneMap,
    UnsupportedHdr,
}

#[derive(Clone)]
struct SourceInfo {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    color_policy: ColorPolicy,
    duration: f64,
}
#[derive(Default)]
struct Worker {
    binary: Option<PathBuf>,
    sidecar_failure: Option<&'static str>,
    sources: VecDeque<SourceInfo>,
}
#[derive(Default)]
pub struct ThumbnailManager(Mutex<Worker>, Mutex<Cancellation>);

#[derive(Default)]
struct Cancellation {
    owner: Option<String>,
    active: Option<(String, Arc<AtomicBool>)>,
    cancelled: VecDeque<String>,
}
impl Cancellation {
    fn cancel(&mut self, id: &str) {
        if let Some((active_id, flag)) = &self.active {
            if active_id == id {
                flag.store(true, Ordering::Release);
            }
        }
        if !self.cancelled.iter().any(|old| old == id) {
            self.cancelled.push_back(id.to_owned());
            if self.cancelled.len() > 32 {
                self.cancelled.pop_front();
            }
        }
    }
}
struct ActiveRequest<'a> {
    manager: &'a ThumbnailManager,
    id: String,
}
impl Drop for ActiveRequest<'_> {
    fn drop(&mut self) {
        let mut state = self.manager.1.lock().unwrap_or_else(|e| e.into_inner());
        if state.active.as_ref().is_some_and(|(id, _)| id == &self.id) {
            state.active = None;
        }
    }
}

impl ThumbnailManager {
    // Register lifecycle ownership without source I/O or decoder startup. Resolve
    // the HDR policy on demand, independently of incomplete startup mpv tags.
    pub fn start(
        &self,
        _filesystem: &Filesystem,
        owner: &str,
        provider: Option<&str>,
        requested: &str,
        _diagnostics: &PlaybackDiagnostics,
        duration: f64,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), NativeError> {
        if provider.unwrap_or("local") == "local" && !cancelled.load(Ordering::Acquire) {
            self.1.lock().unwrap_or_else(|e| e.into_inner()).owner = Some(owner.into());
            if std::env::var_os("VESPERWIND_MEDIA_TRACE").is_some() {
                eprintln!("[thumbnail] registered owner={owner:?} provider={provider:?} path={requested:?} duration={duration}");
            }
        }
        Ok(())
    }
    pub fn cancel(&self, owner: &str) {
        let mut state = self.1.lock().unwrap_or_else(|e| e.into_inner());
        if state.owner.as_deref() != Some(owner) {
            return;
        }
        if let Some((id, _)) = &state.active {
            let id = id.clone();
            state.cancel(&id);
        }
        state.owner = None;
        drop(state);
        // The cancelled child is killed/reaped and its pipe readers joined before
        // this lock is released. No playback state is changed.
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sources
            .clear();
    }
    pub fn shutdown(&self) {
        let mut state = self.1.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((id, _)) = &state.active {
            let id = id.clone();
            state.cancel(&id);
        }
        state.owner = None;
        drop(state);
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sources
            .clear();
    }
    pub fn generate(
        &self,
        filesystem: &Filesystem,
        request: ThumbnailRequest,
    ) -> Result<Thumbnail, NativeError> {
        self.generate_with_resolver(filesystem, request, bundled_binary)
    }
    fn generate_with_resolver(
        &self,
        filesystem: &Filesystem,
        request: ThumbnailRequest,
        resolve_binary: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<Thumbnail, NativeError> {
        if request.cancel {
            if let Some(id) = request
                .request_id
                .as_deref()
                .filter(|id| !id.is_empty() && id.len() <= 128)
            {
                self.1.lock().unwrap_or_else(|e| e.into_inner()).cancel(id);
            }
            return Ok(Thumbnail::unavailable("cancelled"));
        }
        if request.provider_id.as_deref().unwrap_or("local") != "local" {
            return Ok(Thumbnail::unavailable("remote"));
        }
        if !request.time.is_finite() || request.time < 0.0 || !(64..=480).contains(&request.width) {
            return Err(NativeError::new(
                "EINVAL",
                "Invalid thumbnail timestamp or size",
            ));
        }
        // Do not build a queue of blocking workers across multiple WebViews.
        let Ok(mut worker) = self.0.try_lock() else {
            return Ok(Thumbnail::unavailable("busy"));
        };
        let id = request
            .request_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 128 {
            return Err(NativeError::new("EINVAL", "Invalid thumbnail request ID"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.1.lock().unwrap_or_else(|e| e.into_inner());
            if state.cancelled.iter().any(|old| old == &id) {
                return Ok(Thumbnail::unavailable("cancelled"));
            }
            state.active = Some((id.clone(), Arc::clone(&flag)));
        }
        let _active = ActiveRequest { manager: self, id };
        let resolved = paths::resolve_inside_root(filesystem, &request.path)?;
        let path = paths::verify_existing_inside_root(filesystem, &resolved)?;
        let metadata =
            fs::metadata(&path).map_err(|e| NativeError::from_io(&e, "Video unavailable"))?;
        if !metadata.is_file() {
            return Err(NativeError::new("EINVAL", "A local video file is required"));
        }
        if worker.binary.is_none() {
            let Some(binary) = resolve_binary() else {
                if worker.sidecar_failure != Some("sidecar-missing") {
                    eprintln!("[thumbnail] missing owned FFmpeg sidecar (executable={:?}); build/stage the pinned thumbnail FFmpeg", std::env::current_exe());
                    worker.sidecar_failure = Some("sidecar-missing");
                }
                return Ok(Thumbnail::unavailable("sidecar-missing"));
            };
            let version = run_cancelled(&binary, &["-version".into()], MAX_LOG, &flag)?;
            if !version.success || !is_pinned_version(&String::from_utf8_lossy(&version.stdout)) {
                if worker.sidecar_failure != Some("sidecar-version") {
                    eprintln!("[thumbnail] incompatible FFmpeg sidecar {binary:?}: {:?}; expected FFmpeg 8.0", String::from_utf8_lossy(&version.stdout).lines().next());
                    worker.sidecar_failure = Some("sidecar-version");
                }
                return Ok(Thumbnail::unavailable("sidecar-version"));
            }
            worker.sidecar_failure = None;
            worker.binary = Some(binary);
        }
        let binary = worker.binary.as_ref().unwrap().clone();
        let modified = metadata.modified().ok();
        let source = worker
            .sources
            .iter()
            .find(|s| s.path == path && s.size == metadata.len() && s.modified == modified)
            .cloned();
        let source = match source {
            Some(source) => source,
            None => {
                // FFmpeg's input header exposes HDR transfer/side metadata without
                // decoding a frame. No ffprobe or second player is required.
                let probe = run_cancelled(
                    &binary,
                    &[
                        "-hide_banner".into(),
                        "-nostdin".into(),
                        "-protocol_whitelist".into(),
                        "file,pipe".into(),
                        "-i".into(),
                        path.as_os_str().to_owned(),
                    ],
                    MAX_LOG,
                    &flag,
                )?;
                let log = String::from_utf8_lossy(&probe.stderr);
                // No output is intentional; FFmpeg normally exits 1 here.
                if !log.contains("Input #0") || !log.contains("Video:") {
                    return Ok(Thumbnail::unavailable("unsupported"));
                }
                let source = SourceInfo {
                    path: path.clone(),
                    size: metadata.len(),
                    modified,
                    color_policy: color_policy(&first_video_stream(&log)),
                    duration: input_duration(&log).unwrap_or(0.0),
                };
                worker.sources.retain(|s| s.path != path);
                worker.sources.push_back(source.clone());
                if worker.sources.len() > 8 {
                    worker.sources.pop_front();
                }
                source
            }
        };
        if source.color_policy == ColorPolicy::UnsupportedHdr {
            return Ok(Thumbnail::unavailable("unsupported-hdr"));
        }
        let time = if source.duration > 0.0 {
            request.time.min((source.duration - 0.1).max(0.0))
        } else {
            request.time
        };
        let frame = run_cancelled(
            &binary,
            &frame_args(&path, time, request.width, source.color_policy),
            MAX_IMAGE,
            &flag,
        )?;
        if flag.load(Ordering::Acquire) {
            return Ok(Thumbnail::unavailable("cancelled"));
        }
        let log = String::from_utf8_lossy(&frame.stderr);
        // Input HDR metadata remains in the log, so validate the OUTPUT filter's
        // color tags instead of rejecting every log mentioning the HDR source.
        if source.color_policy == ColorPolicy::ToneMap {
            if !output_is_bt709(&log) {
                return Ok(Thumbnail::unavailable("tone-map"));
            }
        } else if is_hdr(&decoded_frame_info(&log)) {
            // Untagged stream headers can reveal HDR only during decoding.
            return Ok(Thumbnail::unavailable("unsupported-hdr"));
        }
        if !frame.success
            || !frame.stdout.starts_with(&[0xff, 0xd8])
            || !frame.stdout.ends_with(&[0xff, 0xd9])
        {
            return Ok(Thumbnail::unavailable("decode"));
        }
        Ok(Thumbnail {
            status: "ready",
            reason: None,
            time: Some(time),
            url: Some(format!(
                "data:image/jpeg;base64,{}",
                STANDARD.encode(frame.stdout)
            )),
        })
    }
}

pub(crate) fn bundled_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    if cfg!(debug_assertions) {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!(
                    "ffmpeg-{}{extension}",
                    env!("VESPERWIND_TARGET_TRIPLE")
                )),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.is_absolute() && p.is_file())
}

pub(crate) fn is_pinned_version(log: &str) -> bool {
    let version = log
        .strip_prefix("ffmpeg version ")
        .and_then(|s| s.split_whitespace().next());
    version.is_some_and(|v| v == "8.0" || v.starts_with("8.0-"))
}
fn is_hdr(log: &str) -> bool {
    let log = log.to_ascii_lowercase();
    [
        "smpte2084",
        "arib-std-b67",
        "smpte428",
        "dovi",
        "dolby vision",
        "mastering display metadata",
        "content light level metadata",
    ]
    .iter()
    .any(|marker| log.contains(marker))
}
// Only the first video stream is extracted. Metadata of other streams must
// not decide its conversion policy (e.g. an SDR main stream plus HDR alternate).
pub(crate) fn first_video_stream(log: &str) -> String {
    let mut lines = log
        .lines()
        .skip_while(|line| !(line.contains("Stream #0:") && line.contains("Video:")));
    let Some(header) = lines.next() else {
        return String::new();
    };
    let mut selected = vec![header];
    selected.extend(
        lines.take_while(|line| {
            !line.contains("Stream #0:") && !line.contains("At least one output")
        }),
    );
    selected.join("\n")
}
fn color_policy(log: &str) -> ColorPolicy {
    if !is_hdr(log) {
        return ColorPolicy::Sdr;
    }
    let lower = log.to_ascii_lowercase();
    // FFmpeg decodes only the base layer; it never applies the RPU. A stream
    // without a backward-compatible base layer (profile 5, compatibility id 0)
    // would produce wrong colors, so it gets no thumbnail.
    let unsupported_dovi = super::dolby_vision::parse_configuration_record(log)
        .map(|record| record.profile == 5 || record.compatibility_id == 0)
        .unwrap_or_else(|| {
            ["profile: 5", "profile=5", "dv_profile=5"]
                .iter()
                .any(|marker| lower.contains(marker))
        });
    if !unsupported_dovi
        && lower.contains("bt2020")
        && (lower.contains("smpte2084") || lower.contains("arib-std-b67"))
    {
        // PQ/HLG, including a compatible Dolby Vision base layer. RPU or
        // enhancement-layer reconstruction is intentionally not claimed.
        ColorPolicy::ToneMap
    } else {
        ColorPolicy::UnsupportedHdr
    }
}
fn decoded_frame_info(log: &str) -> String {
    log.lines()
        .filter(|line| line.contains("showinfo"))
        .collect::<Vec<_>>()
        .join("\n")
}
fn output_is_bt709(log: &str) -> bool {
    log.lines()
        .filter(|line| line.contains("color_range:"))
        .last()
        .is_some_and(|line| {
            line.contains("color_space:bt709")
                && line.contains("color_primaries:bt709")
                && line.contains("color_trc:bt709")
        })
}
fn frame_filter(width: u32, policy: ColorPolicy) -> String {
    let resize =
        format!("scale=w={width}:h=270:force_original_aspect_ratio=decrease:force_divisible_by=2");
    if policy == ColorPolicy::ToneMap {
        // FFmpeg 8's built-in libswscale CMS does transfer conversion plus
        // perceptual tone/gamut mapping, with source HDR metadata and an SDR
        // BT.709 target. Do not chain another tonemap after it (double mapping).
        format!("showinfo,{resize}:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:intent=perceptual,format=yuvj420p,setsar=1,sidedata=mode=delete,showinfo")
    } else {
        format!("showinfo,{resize},setsar=1,showinfo")
    }
}
fn input_duration(log: &str) -> Option<f64> {
    let value = log.split("Duration: ").nth(1)?.split(',').next()?;
    let parts: Vec<f64> = value
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if parts.len() != 3 {
        return None;
    }
    let duration = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2];
    (duration.is_finite() && duration > 0.0).then_some(duration)
}
fn frame_args(path: &Path, time: f64, width: u32, policy: ColorPolicy) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-protocol_whitelist",
        "file,pipe",
        "-threads",
        "1",
        "-ss",
        &format!("{time:.3}"),
        "-i",
    ]
    .iter()
    .map(Into::into)
    .collect();
    args.push(path.as_os_str().to_owned());
    args.extend(
        [
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-filter_threads",
            "1",
            "-vf",
            &frame_filter(width, policy),
            "-threads",
            "1",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "-f",
            "image2pipe",
            "pipe:1",
        ]
        .iter()
        .map(Into::into),
    );
    args
}

pub(crate) struct ProcessOutput {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}
fn read_pipe(mut pipe: impl Read, limit: usize, overflow: Arc<AtomicBool>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if pipe
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > limit
    {
        overflow.store(true, Ordering::Relaxed);
    }
    bytes
}
pub(crate) fn run_cancelled(
    binary: &Path,
    args: &[std::ffi::OsString],
    limit: usize,
    cancel: &AtomicBool,
) -> Result<ProcessOutput, NativeError> {
    if cancel.load(Ordering::Acquire) {
        return Err(NativeError::new(
            "ETHUMBNAIL_CANCELLED",
            "Thumbnail request cancelled",
        ));
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000); // CREATE_NO_WINDOW
    }
    let launched = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|e| NativeError::from_io(&e, "Bundled FFmpeg could not start"))?;
    #[cfg(unix)]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, child.id(), 10);
    }
    let spawn_ms = launched.elapsed().as_secs_f64() * 1000.0;
    if std::env::var_os("VESPERWIND_THUMBNAIL_LOG").is_some() {
        eprintln!("[thumbnail] child={} single-frame/request", child.id());
    }
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdout_flag = Arc::clone(&overflow);
    let stderr_flag = Arc::clone(&overflow);
    let out = thread::spawn(move || read_pipe(stdout, limit, stdout_flag));
    let err = thread::spawn(move || read_pipe(stderr, MAX_LOG, stderr_flag));
    let start = Instant::now();
    let result = loop {
        if cancel.load(Ordering::Acquire) {
            break Err(NativeError::new(
                "ETHUMBNAIL_CANCELLED",
                "Thumbnail request cancelled",
            ));
        }
        if overflow.load(Ordering::Relaxed) || start.elapsed() > Duration::from_secs(12) {
            break Err(NativeError::new(
                "ETHUMBNAIL_LIMIT",
                "Thumbnail extraction exceeded its limit",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => break Err(NativeError::from_io(&e, "Thumbnail extraction failed")),
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let success = result?;
    if std::env::var_os("VESPERWIND_MEDIA_TRACE").is_some() {
        let phase = if args.iter().any(|a| a == "-version") {
            "startup-version"
        } else if args.iter().any(|a| a == "image2pipe") {
            "seek-decode-jpeg"
        } else {
            "source-probe"
        };
        eprintln!(
            "[thumbnail-timing] phase={phase} spawnMs={spawn_ms:.3} processMs={:.3} stdoutBytes={}",
            launched.elapsed().as_secs_f64() * 1000.0,
            stdout.len()
        );
    }
    if overflow.load(Ordering::Relaxed) {
        return Err(NativeError::new(
            "ETHUMBNAIL_LIMIT",
            "Thumbnail output exceeded its limit",
        ));
    }
    Ok(ProcessOutput {
        success,
        stdout,
        stderr,
    })
}

#[cfg(test)]
fn run(
    binary: &Path,
    args: &[std::ffi::OsString],
    limit: usize,
) -> Result<ProcessOutput, NativeError> {
    run_cancelled(binary, args, limit, &AtomicBool::new(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_version_and_hdr_policy() {
        assert!(is_pinned_version("ffmpeg version 8.0 Copyright"));
        assert!(!is_pinned_version("ffmpeg version 8.1 Copyright"));
        assert!(!is_pinned_version("ffmpeg version 8.0.1 Copyright"));
        for marker in [
            "smpte2084",
            "arib-std-b67",
            "DOVI configuration record",
            "Mastering display metadata",
        ] {
            assert!(is_hdr(marker));
        }
        assert!(!is_hdr("Video: h264 yuv420p(tv, bt709)"));
        assert_eq!(
            input_duration("Duration: 01:02:03.50, start: 0"),
            Some(3723.5)
        );
    }
    #[test]
    fn selects_hdr10_hlg_and_compatible_base_layers_without_claiming_profile5() {
        let pq = "Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/smpte2084)";
        assert_eq!(color_policy(pq), ColorPolicy::ToneMap);
        assert_eq!(
            color_policy(&pq.replace("smpte2084", "arib-std-b67")),
            ColorPolicy::ToneMap
        );
        assert_eq!(
            color_policy(&format!("{pq} DOVI configuration record: profile: 8")),
            ColorPolicy::ToneMap
        );
        assert_eq!(
            color_policy(&format!("{pq} DOVI configuration record: profile: 5")),
            ColorPolicy::UnsupportedHdr
        );
        let record = |profile: u8, compatibility: u8| {
            format!("{pq}\n      DOVI configuration record: version: 1.0, profile: {profile}, level: 6, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: {compatibility}, compression: 0")
        };
        // Compatible base layers keep the base-layer thumbnail; profile 5 and
        // compatibility id 0 never get an uncorrected IPTPQc2 frame.
        assert_eq!(color_policy(&record(8, 1)), ColorPolicy::ToneMap);
        assert_eq!(color_policy(&record(7, 6)), ColorPolicy::ToneMap);
        assert_eq!(color_policy(&record(5, 0)), ColorPolicy::UnsupportedHdr);
        assert_eq!(color_policy(&record(8, 0)), ColorPolicy::UnsupportedHdr);
        assert_eq!(
            color_policy("Video: h264, yuv420p(tv, bt709)"),
            ColorPolicy::Sdr
        );
        assert_eq!(
            color_policy("Video: hevc, Mastering display metadata, transfer unknown"),
            ColorPolicy::UnsupportedHdr
        );
        let multiple = format!(
            "Stream #0:0: Video: h264, yuv420p(tv, bt709)\n  Metadata: normal\nStream #0:1: {pq}"
        );
        assert_eq!(
            color_policy(&first_video_stream(&multiple)),
            ColorPolicy::Sdr
        );
        assert!(!is_hdr(&decoded_frame_info(&format!(
            "{multiple}\n[Parsed_showinfo_0] color_trc:bt709"
        ))));
        assert!(!output_is_bt709("[Parsed_showinfo_0] color_range:tv color_space:bt2020nc color_primaries:bt2020 color_trc:smpte2084"));
    }
    #[test]
    fn filename_is_a_single_argument_and_output_uses_stdout() {
        let path = Path::new("/tmp/My movie; $(touch nope).mp4");
        let args = frame_args(path, 30.0, 180, ColorPolicy::ToneMap);
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], path.as_os_str());
        assert!(args.iter().position(|a| a == "-ss").unwrap() < i);
        let frames = args.iter().position(|a| a == "-frames:v").unwrap();
        assert_eq!(args[frames + 1], "1");
        assert!(!args.iter().any(|a| a.to_string_lossy().contains("fps=")));
        assert_eq!(args.last().unwrap(), "pipe:1");
    }
    #[test]
    fn bounded_output_reader() {
        let overflow = Arc::new(AtomicBool::new(false));
        let bytes = read_pipe(std::io::Cursor::new(vec![1; 20]), 10, Arc::clone(&overflow));
        assert_eq!(bytes.len(), 11);
        assert!(overflow.load(Ordering::Relaxed));
    }
    #[test]
    fn cancellation_ids_are_bounded_and_do_not_cancel_a_newer_request() {
        let flag = Arc::new(AtomicBool::new(false));
        let mut state = Cancellation {
            active: Some(("new".into(), Arc::clone(&flag))),
            ..Default::default()
        };
        state.cancel("old");
        assert!(!flag.load(Ordering::Acquire));
        state.cancel("new");
        assert!(flag.load(Ordering::Acquire));
        for i in 0..100 {
            state.cancel(&i.to_string());
        }
        assert_eq!(state.cancelled.len(), 32);
        assert!(!state.cancelled.iter().any(|id| id == "0"));
        assert!(state.cancelled.iter().any(|id| id == "99"));
    }
    #[test]
    fn opening_video_registers_lifecycle_without_source_io_or_decoder() {
        let root = std::env::temp_dir();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let manager = ThumbnailManager::default();
        let diagnostics = PlaybackDiagnostics::default();
        manager
            .start(
                &filesystem,
                "player-one",
                None,
                "/nonexistent-video",
                &diagnostics,
                7200.0,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        let worker = manager.0.lock().unwrap();
        assert!(worker.binary.is_none());
        assert!(worker.sources.is_empty());
        assert_eq!(
            manager.1.lock().unwrap().owner.as_deref(),
            Some("player-one")
        );
    }
    #[test]
    fn missing_sidecar_is_not_unsupported_media() {
        let root = std::env::temp_dir().join(format!(
            "vesperwind-missing-ffmpeg-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let video = root.join("video.mp4");
        fs::write(&video, b"fixture").unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let manager = ThumbnailManager::default();
        let request = ThumbnailRequest {
            path: video.to_string_lossy().into_owned(),
            time: 0.0,
            width: 180,
            provider_id: Some("local".into()),
            request_id: None,
            cancel: false,
        };
        let result = manager
            .generate_with_resolver(&filesystem, request, || None)
            .unwrap();
        assert_eq!(result.reason, Some("sidecar-missing"));
        assert!(manager.1.lock().unwrap().active.is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pre_cancelled_request_never_resolves_or_opens_source() {
        let root = std::env::temp_dir();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let manager = ThumbnailManager::default();
        let req = |cancel| ThumbnailRequest {
            path: root
                .join("nonexistent-video")
                .to_string_lossy()
                .into_owned(),
            time: 1.0,
            width: 180,
            provider_id: None,
            request_id: Some("cancel-before-start".into()),
            cancel,
        };
        manager.generate(&filesystem, req(true)).unwrap();
        assert_eq!(
            manager.generate(&filesystem, req(false)).unwrap().reason,
            Some("cancelled")
        );
        assert!(manager.0.lock().unwrap().binary.is_none());
        assert!(manager.1.lock().unwrap().active.is_none());
    }
    #[test]
    #[ignore = "Requires the pinned FFmpeg sidecar"]
    fn real_cancel_reaps_child_and_releases_single_worker() {
        let binary = bundled_binary().unwrap();
        let args: Vec<std::ffi::OsString> = [
            "-hide_banner",
            "-nostdin",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=1:duration=60",
            "-threads",
            "1",
            "-c:v",
            "mjpeg",
            "-f",
            "image2pipe",
            "pipe:1",
        ]
        .iter()
        .map(Into::into)
        .collect();
        let flag = Arc::new(AtomicBool::new(false));
        let worker_flag = Arc::clone(&flag);
        let started = Instant::now();
        let task = thread::spawn(move || run_cancelled(&binary, &args, MAX_IMAGE, &worker_flag));
        thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::Release);
        let error = match task.join().unwrap() {
            Err(error) => error,
            Ok(_) => panic!("Uncancelled extraction"),
        };
        assert_eq!(error.code, "ETHUMBNAIL_CANCELLED");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            Arc::strong_count(&flag),
            1,
            "Joined runner and both pipe readers"
        );
        let output = run(&bundled_binary().unwrap(), &["-version".into()], MAX_LOG).unwrap();
        assert!(output.success, "A new child can start after cancellation");
    }
    #[test]
    #[ignore = "Requires the pinned FFmpeg sidecar built by scripts/build-thumbnail-ffmpeg.sh"]
    fn real_frames_hdr_remote_and_concurrency() {
        let binary = bundled_binary().expect("Build the pinned FFmpeg sidecar first");
        let root = std::env::temp_dir().join(format!(
            "vesperwind-thumbnail-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("My movie; $(not-a-shell).mkv");
        let hdr_path = root.join("HDR.mkv");
        let hlg_path = root.join("HLG.mkv");
        for (output, transfer, primaries, matrix) in [
            (&path, "bt709", "bt709", "bt709"),
            (&hdr_path, "smpte2084", "bt2020", "bt2020"),
            (&hlg_path, "arib-std-b67", "bt2020", "bt2020"),
        ] {
            // Encode actual 10-bit PQ/HLG fixtures from a known SDR test pattern.
            // This exercises transfer/gamut conversion, rather than tagging an
            // 8-bit SDR pattern as HDR without changing its sample values.
            let filter = format!(
                "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=out_transfer={transfer}:out_primaries={primaries}:out_color_matrix={matrix}:intent=relative_colorimetric,format={}",
                if transfer == "bt709" { "yuv420p" } else { "yuv420p10le" }
            );
            let args: Vec<std::ffi::OsString> = [
                "-hide_banner",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=10:duration=2",
                "-c:v",
                "ffv1",
                "-vf",
                &filter,
            ]
            .iter()
            .map(Into::into)
            .chain(std::iter::once(output.as_os_str().to_owned()))
            .collect();
            let fixture = run(&binary, &args, MAX_IMAGE).unwrap();
            assert!(
                fixture.success,
                "{}",
                String::from_utf8_lossy(&fixture.stderr)
            );
        }
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let manager = ThumbnailManager::default();
        let request = |path: &Path, time| ThumbnailRequest {
            path: path.to_string_lossy().into_owned(),
            time,
            width: 180,
            provider_id: None,
            request_id: None,
            cancel: false,
        };
        let thumbnail = manager.generate(&filesystem, request(&path, 0.8)).unwrap();
        assert_eq!(thumbnail.status, "ready");
        assert!(thumbnail
            .url
            .unwrap()
            .starts_with("data:image/jpeg;base64,/9j/"));
        assert_eq!(
            manager
                .generate(&filesystem, request(&path, 20.0))
                .unwrap()
                .status,
            "ready"
        );
        for input in [&hdr_path, &hlg_path] {
            let thumbnail = manager.generate(&filesystem, request(input, 0.5)).unwrap();
            assert_eq!(
                thumbnail.status, "ready",
                "HDR source must produce an SDR JPEG"
            );
            assert_eq!(
                manager
                    .0
                    .lock()
                    .unwrap()
                    .sources
                    .iter()
                    .find(|source| source.path == fs::canonicalize(input).unwrap())
                    .unwrap()
                    .color_policy,
                ColorPolicy::ToneMap,
                "The manager must select HDR conversion for this fixture"
            );
            assert!(thumbnail
                .url
                .unwrap()
                .starts_with("data:image/jpeg;base64,/9j/"));
            let frame = run(
                &binary,
                &frame_args(input, 0.5, 180, ColorPolicy::ToneMap),
                MAX_IMAGE,
            )
            .unwrap();
            assert!(frame.success);
            assert!(output_is_bt709(&String::from_utf8_lossy(&frame.stderr)));
            // Decode directly to raw RGB as well: ensure actual pixels change,
            // rather than merely replacing JPEG color tags or HDR metadata.
            let pixels = |policy| {
                let mut args = frame_args(input, 0.5, 180, policy);
                let codec = args.iter().position(|a| a == "-c:v").unwrap();
                args.truncate(codec);
                args.extend(
                    [
                        "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
                    ]
                    .iter()
                    .map(Into::into),
                );
                let frame = run(&binary, &args, MAX_IMAGE).unwrap();
                assert!(frame.success);
                frame.stdout
            };
            let converted = pixels(ColorPolicy::ToneMap);
            let naive = pixels(ColorPolicy::Sdr);
            assert_eq!(converted.len(), naive.len());
            assert!(!converted.is_empty());
            assert_ne!(converted, naive, "Tone mapping must transform pixels");
        }
        let remote = ThumbnailRequest {
            provider_id: Some("ssh:test".into()),
            ..request(&path, 0.0)
        };
        assert_eq!(
            manager.generate(&filesystem, remote).unwrap().reason,
            Some("remote")
        );
        let guard = manager.0.lock().unwrap();
        assert_eq!(
            manager
                .generate(&filesystem, request(&path, 0.0))
                .unwrap()
                .reason,
            Some("busy")
        );
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }
}
