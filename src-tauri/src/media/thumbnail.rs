//! Thumbnail extraction is independent of playback. Only application-owned
//! FFmpeg is resolved; neither PATH nor a user-configurable executable is used.
use crate::{
    error::NativeError,
    filesystem::{paths, Filesystem},
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
    sources: VecDeque<SourceInfo>,
}
#[derive(Default)]
pub struct ThumbnailManager(Mutex<Worker>);

impl ThumbnailManager {
    pub fn generate(
        &self,
        filesystem: &Filesystem,
        request: ThumbnailRequest,
    ) -> Result<Thumbnail, NativeError> {
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
        let resolved = paths::resolve_inside_root(filesystem, &request.path)?;
        let path = paths::verify_existing_inside_root(filesystem, &resolved)?;
        let metadata =
            fs::metadata(&path).map_err(|e| NativeError::from_io(&e, "Video unavailable"))?;
        if !metadata.is_file() {
            return Err(NativeError::new("EINVAL", "A local video file is required"));
        }
        if worker.binary.is_none() {
            let Some(binary) = bundled_binary() else {
                return Ok(Thumbnail::unavailable("sidecar-missing"));
            };
            let version = run(&binary, &["-version".into()], MAX_LOG)?;
            if !version.success || !is_pinned_version(&String::from_utf8_lossy(&version.stdout)) {
                return Ok(Thumbnail::unavailable("sidecar-version"));
            }
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
                let probe = run(
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
        let frame = run(
            &binary,
            &frame_args(&path, time, request.width, source.color_policy),
            MAX_IMAGE,
        )?;
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

fn bundled_binary() -> Option<PathBuf> {
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

fn is_pinned_version(log: &str) -> bool {
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
fn first_video_stream(log: &str) -> String {
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
    let unsupported_dovi = ["profile: 5", "profile=5", "dv_profile=5"]
        .iter()
        .any(|marker| lower.contains(marker));
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

struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
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
fn run(
    binary: &Path,
    args: &[std::ffi::OsString],
    limit: usize,
) -> Result<ProcessOutput, NativeError> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| NativeError::from_io(&e, "Bundled FFmpeg could not start"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdout_flag = Arc::clone(&overflow);
    let stderr_flag = Arc::clone(&overflow);
    let out = thread::spawn(move || read_pipe(stdout, limit, stdout_flag));
    let err = thread::spawn(move || read_pipe(stderr, MAX_LOG, stderr_flag));
    let start = Instant::now();
    let result = loop {
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
