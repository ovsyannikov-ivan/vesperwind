use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn play_vod(uri: &str, ca: Option<&std::path::Path>) {
    let api = MpvApi::load_bundled().unwrap();
    let handle = unsafe { (api.create)() };
    assert!(!handle.is_null());
    for (name, value) in [
        ("config", "no"),
        ("terminal", "no"),
        ("vo", "null"),
        ("ao", "null"),
        ("keep-open", "yes"),
        ("audio-display", "no"),
        ("hwdec", "auto-copy-safe"),
        ("network-timeout", "3"),
    ] {
        api.set_option(handle, name, value).unwrap();
    }
    if let Some(path) = std::env::var_os("VESPERWIND_MPV_NETWORK_LOG") {
        api.set_option(handle, "log-file", &path.to_string_lossy())
            .unwrap();
        api.set_option(handle, "msg-level", "all=v").unwrap();
    }
    if let Some(ca) = ca {
        // SecureTransport loads the custom test CA through avio; allow that
        // local file only in this test, retaining production network sandboxing.
        api.set_option(
            handle,
            "stream-lavf-o",
            "protocol_whitelist=\"http,https,tls,file,tcp,crypto,httpproxy\"",
        )
        .unwrap();
        api.set_option(handle, "tls-ca-file", &ca.to_string_lossy())
            .unwrap();
        // FFmpeg 8 Schannel uses the Windows trust store and cannot consume a
        // custom CA file. This exception is only for this loopback test server.
        #[cfg(target_os = "windows")]
        api.set_option(handle, "tls-verify", "no").unwrap();
        #[cfg(target_os = "macos")]
        api.set_option(handle, "tls-verify", "yes").unwrap();
    }
    status(unsafe { (api.initialize)(handle) }, "initialize").unwrap();
    api.command(handle, &["loadfile", uri, "replace"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut loaded = false;
    let mut decoded = false;
    let mut eof = false;
    let mut hwdec = None;
    while Instant::now() < deadline {
        let event = api.wait_event_details(handle, 0.05);
        if event.event_id == MPV_EVENT_FILE_LOADED {
            loaded = true;
        }
        if loaded {
            decoded |= api.get_i64(handle, "decoder-frame-drop-count").is_some()
                && api.get_double(handle, "time-pos").is_some_and(|v| v > 1.0);
            hwdec = api
                .get_string(handle, "hwdec-current")
                .filter(|v| v != "no")
                .or(hwdec);
            if api.get_flag(handle, "eof-reached") == Some(true) {
                eof = true;
                break;
            }
        }
        if event.event_id == MPV_EVENT_END_FILE && event.end_file_error < 0 {
            break;
        }
    }
    let width = api.get_i64(handle, "video-params/w");
    api.destroy(handle);
    assert!(loaded && eof, "VOD did not load and reach EOF");
    if uri.contains("m3u8") {
        assert!(decoded);
        assert_eq!(width, Some(160));
        eprintln!("HLS H.264 MPEG-TS multi-segment VOD: hwdec-current={hwdec:?}");
        if let Some(hwdec) = hwdec {
            #[cfg(target_os = "macos")]
            assert!(hwdec.starts_with("videotoolbox"));
            #[cfg(target_os = "windows")]
            assert!(hwdec.starts_with("d3d11va") || hwdec.starts_with("dxva2"));
        }
    }
}

#[test]
fn bundled_hls_http_master_and_local_vod_decode_multiple_segments_to_eof() {
    let server = crate::media::network_fixtures::Server::new();
    play_vod(&server.url("/local-hls/master.m3u8"), None);
    let local = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test/fixtures/media/local-hls/playlist.m3u8");
    play_vod(&local.to_string_lossy(), None);
}

#[test]
fn bundled_https_audio_and_hls_verify_controlled_certificate() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/media");
    let mut child = Child(
        Command::new("node")
            .arg(fixtures.join("https-server.cjs"))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut port = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut port)
        .unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let ca = fixtures.join("tls/fixture-ca.pem");
    play_vod(&format!("https://127.0.0.1:{port}/native.mp3"), Some(&ca));
    play_vod(
        &format!("https://127.0.0.1:{port}/local-hls/master.m3u8"),
        Some(&ca),
    );
}
