//! mpv owns container demuxing for both native playback and HTML media metadata.
use super::{
    stream::MpvStreamRegistry, MpvApi, MpvHandle, MPV_EVENT_END_FILE, MPV_EVENT_FILE_LOADED,
    MPV_EVENT_SHUTDOWN,
};
#[cfg(test)]
use crate::{provider_content::ContentSource, ssh::SshManager};
use serde::Serialize;
use std::{
    ffi::CString,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub index: usize,
    pub title: String,
    pub start_time: f64,
}

pub(super) fn read(api: &MpvApi, handle: *mut MpvHandle) -> Vec<Chapter> {
    let count = api
        .get_i64(handle, "chapter-list/count")
        .unwrap_or(0)
        .max(0);
    (0..count)
        .filter_map(|index| {
            let start_time = api.get_double(handle, &format!("chapter-list/{index}/time"))?;
            if !start_time.is_finite() || start_time < 0.0 {
                return None;
            }
            let title = api
                .get_string(handle, &format!("chapter-list/{index}/title"))
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| format!("Chapter {}", index + 1));
            Some(Chapter {
                index: index as usize,
                title,
                start_time,
            })
        })
        .collect()
}

pub(crate) fn current_index(chapters: &[Chapter], seconds: f64) -> Option<usize> {
    chapters
        .iter()
        .filter(|c| c.start_time <= seconds)
        .max_by(|a, b| {
            a.start_time
                .total_cmp(&b.start_time)
                .then(a.index.cmp(&b.index))
        })
        .map(|c| c.index)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub duration: Option<f64>,
    pub chapters: Vec<Chapter>,
    pub tags: AudioTags,
    pub kind: Option<String>,
    pub format: Option<String>,
    pub live: bool,
    pub tracks: Vec<ProbeTrack>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<String>,
    pub disc_number: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct ProbeTrack {
    pub kind: String,
    pub codec: Option<String>,
}
pub(super) fn read_tags(api: &MpvApi, handle: *mut MpvHandle) -> AudioTags {
    let mut tags = AudioTags::default();
    let count = api
        .get_i64(handle, "metadata/list/count")
        .unwrap_or(0)
        .clamp(0, 256);
    for index in 0..count {
        let key = api
            .get_string(handle, &format!("metadata/list/{index}/key"))
            .unwrap_or_default()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "");
        let value = api
            .get_string(handle, &format!("metadata/list/{index}/value"))
            .filter(|s| !s.trim().is_empty());
        match key.as_str() {
            "title" => tags.title = value,
            "artist" => tags.artist = value,
            "album" => tags.album = value,
            "albumartist" => tags.album_artist = value,
            "track" | "tracknumber" => tags.track_number = value,
            "disc" | "discnumber" => tags.disc_number = value,
            _ => {}
        }
    }
    tags
}
fn read_probe_tracks(api: &MpvApi, handle: *mut MpvHandle) -> Vec<ProbeTrack> {
    (0..api
        .get_i64(handle, "track-list/count")
        .unwrap_or(0)
        .clamp(0, 256))
        .filter_map(|index| {
            let prefix = format!("track-list/{index}");
            if api
                .get_flag(handle, &format!("{prefix}/albumart"))
                .unwrap_or(false)
            {
                return None;
            }
            let kind = api.get_string(handle, &format!("{prefix}/type"))?;
            Some(ProbeTrack {
                kind,
                codec: api.get_string(handle, &format!("{prefix}/codec")),
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn probe(source: ContentSource, ssh: Arc<SshManager>) -> Result<Vec<Chapter>, String> {
    probe_metadata(source, ssh).map(|metadata| metadata.chapters)
}

/// No rendering surface, audio device, watch-later files, or system executable.
/// The registry must outlive mpv_destroy (stream callbacks run on mpv threads).
#[cfg(test)]
pub(crate) fn probe_metadata(
    source: ContentSource,
    ssh: Arc<SshManager>,
) -> Result<SourceMetadata, String> {
    let registry = MpvStreamRegistry::new(ssh);
    let uri = registry.register(source);
    probe_uri(&uri, registry, None)
}

pub(crate) fn probe_uri(
    uri: &str,
    registry: Arc<MpvStreamRegistry>,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<SourceMetadata, String> {
    let api = MpvApi::load_bundled()?;
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        return Err("mpv_create failed".into());
    }
    // Owned fixture diagnostics only; production probes never log source URLs.
    #[cfg(test)]
    let fixture_log =
        std::env::temp_dir().join(format!("vw-metadata-{}.log", uuid::Uuid::new_v4()));
    let result = (|| {
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("idle", "yes"),
            ("pause", "yes"),
            ("vo", "null"),
            ("ao", "null"),
            ("keep-open", "always"),
            ("audio-display", "no"),
            ("sub-auto", "no"),
            ("network-timeout", "3"),
            ("tls-verify", "yes"),
            ("msg-level", "all=no"),
        ] {
            api.set_option(handle, name, value)
                .map_err(|error| format!("{name}={value}: {error}"))?;
        }
        #[cfg(test)]
        {
            api.set_option(handle, "log-file", &fixture_log.to_string_lossy())?;
            api.set_option(handle, "msg-level", "all=v")?;
        }
        let protocol = CString::new("vesperwind").unwrap();
        super::status(
            unsafe {
                (api.stream_add)(
                    handle,
                    protocol.as_ptr(),
                    Arc::as_ptr(&registry).cast_mut().cast(),
                    super::stream::open_stream,
                )
            },
            "mpv_stream_cb_add_ro",
        )?;
        super::status(unsafe { (api.initialize)(handle) }, "mpv_initialize")?;
        api.command(handle, &["loadfile", uri, "replace"])?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if cancelled.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
                return Err("Metadata probe cancelled".into());
            }
            let event = api.wait_event_details(handle, 0.05);
            match event.event_id {
                MPV_EVENT_FILE_LOADED => {
                    let tracks = read_probe_tracks(&api, handle);
                    let kind = if tracks.iter().any(|t| t.kind == "video") {
                        Some("video".into())
                    } else if tracks.iter().any(|t| t.kind == "audio") {
                        Some("audio".into())
                    } else {
                        None
                    };
                    return Ok(SourceMetadata {
                        kind,
                        format: api.get_string(handle, "file-format"),
                        tracks,
                        tags: read_tags(&api, handle),
                        live: api.get_flag(handle, "demuxer-via-network").unwrap_or(false)
                            && api.get_double(handle, "duration").is_none(),
                        duration: api
                            .get_double(handle, "duration")
                            .filter(|d| d.is_finite() && *d > 0.0),
                        chapters: read(&api, handle),
                    });
                }
                // A playlist/stream redirect can end the initial load before
                // the final media's FILE_LOADED. Only a failed load is fatal.
                MPV_EVENT_END_FILE if event.end_file_error < 0 => {
                    return Err(format!(
                        "Unable to inspect this media source: {}",
                        api.error_string(event.end_file_error)
                    ))
                }
                MPV_EVENT_SHUTDOWN => return Err("Metadata player shut down".into()),
                _ => {}
            }
        }
        Err("Source metadata load timed out".into())
    })();
    api.destroy(handle);
    #[cfg(test)]
    {
        if result.is_err() {
            if let Ok(log) = std::fs::read_to_string(&fixture_log) {
                eprintln!("Owned metadata fixture diagnostics:\n{log}");
            }
        }
        let _ = std::fs::remove_file(fixture_log);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn bundled_network_probe_routes_tracks_tags_redirects_hls_and_failure_with_time_bounds() {
        let server = crate::media::network_fixtures::Server::new();
        let registry = || MpvStreamRegistry::new(SshManager::new());
        for (path, kind) in [
            ("/native.mp3?looks=video.mp4", "audio"),
            ("/tagged.flac", "audio"),
            ("/chapters.mp4", "video"),
            ("/native-h264.mp4", "video"),
            ("/redirect", "audio"),
            ("/local-hls/master.m3u8", "video"),
            ("/local-hls/playlist.m3u8", "video"),
        ] {
            let result = probe_uri(&server.url(path), registry(), None)
                .unwrap_or_else(|error| panic!("Owned fixture {path}: {error}"));
            assert_eq!(result.kind.as_deref(), Some(kind), "{path}: {result:?}");
            assert!(result.duration.is_some(), "{path}");
            if path.ends_with(".m3u8") {
                assert_eq!(result.format.as_deref(), Some("hls"));
            }
            if path == "/tagged.flac" {
                assert_eq!(result.tags.title.as_deref(), Some("Время 日本語"));
                assert_eq!(result.tags.artist.as_deref(), Some("Test Artist"));
                assert_eq!(result.tags.album.as_deref(), Some("Test Album"));
                assert_eq!(result.tags.album_artist.as_deref(), Some("Album Artist"));
                assert_eq!(result.tags.track_number.as_deref(), Some("2/9"));
                assert_eq!(result.tags.disc_number.as_deref(), Some("1/2"));
            }
        }
        assert!(probe_uri(&server.url("/missing"), registry(), None).is_err());
        let started = Instant::now();
        assert!(probe_uri(&server.url("/slow"), registry(), None).is_err());
        assert!(started.elapsed() < Duration::from_secs(12));
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            flag.store(true, std::sync::atomic::Ordering::Release);
        });
        let started = Instant::now();
        assert!(probe_uri(&server.url("/slow"), registry(), Some(&cancelled)).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        worker.join().unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn local_hls_uses_validated_unicode_path_for_relative_segments() {
        let root =
            std::env::temp_dir().join(format!("vw-HLS-日本語-Время-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let original = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/media/local-hls");
        for file in std::fs::read_dir(original).unwrap() {
            let file = file.unwrap();
            std::fs::copy(file.path(), root.join(file.file_name())).unwrap();
        }
        let filesystem = crate::filesystem::Filesystem::from_root(&root, root.clone()).unwrap();
        let ssh = SshManager::new();
        let registry = MpvStreamRegistry::new(Arc::clone(&ssh));
        let location = crate::media::source::MediaSource {
            source_type: Some("provider".into()),
            provider_id: Some("local".into()),
            path: root.join("master.m3u8").to_string_lossy().into_owned(),
            ..Default::default()
        };
        let source = location.resolve(&filesystem, &ssh, &registry).unwrap();
        assert!(!source.uri.starts_with("vesperwind:"));
        assert!(!source.history_enabled);
        let metadata = probe_uri(&source.uri, registry, None).unwrap();
        assert_eq!(metadata.kind.as_deref(), Some("video"));
        assert!((metadata.duration.unwrap() - 7.0).abs() < 0.2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn current_chapter_tracks_boundaries_and_absolute_resume() {
        let chapters = vec![
            Chapter {
                index: 0,
                title: "Вступление 日本語".into(),
                start_time: 0.0,
            },
            Chapter {
                index: 1,
                title: "Chapter 2".into(),
                start_time: 15720.0,
            },
            Chapter {
                index: 2,
                title: "Конец".into(),
                start_time: 17340.0,
            },
        ];
        assert_eq!(current_index(&[], 16638.0), None);
        assert_eq!(current_index(&chapters, 15719.99), Some(0));
        assert_eq!(current_index(&chapters, 15720.0), Some(1));
        assert_eq!(current_index(&chapters, 16638.0), Some(1));
        assert_eq!(current_index(&chapters, 17340.0), Some(2));
        assert_eq!(
            serde_json::to_value(&chapters).unwrap()[0]["title"],
            "Вступление 日本語"
        );
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn fixture(name: &str) -> (ContentSource, Arc<SshManager>) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/media")
            .canonicalize()
            .unwrap();
        let filesystem = crate::filesystem::Filesystem::from_root(&root, root.clone()).unwrap();
        let ssh = SshManager::new();
        let source = ContentSource::open(
            &filesystem,
            &ssh,
            Some("local"),
            &root.join(name).to_string_lossy(),
        )
        .unwrap();
        (source, ssh)
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn bundled_mpv_chapters_from_mkv_mp4_m4b_and_no_chapters() {
        for name in ["chapters.mkv", "chapters.mp4", "book.m4b"] {
            let (source, ssh) = fixture(name);
            let chapters = probe(source, ssh).unwrap();
            assert_eq!(chapters.len(), 3, "{name}: {chapters:?}");
            assert_eq!(chapters[0].title, "Вступление 日本語", "{name}");
            assert_eq!(chapters[1].title, "Chapter 2", "{name}");
            assert_eq!(chapters[2].title, "Fin — café", "{name}");
            for (chapter, start) in chapters.iter().zip([0.0, 25.25, 80.5]) {
                assert!(
                    (chapter.start_time - start).abs() < 0.001,
                    "{name}: {chapter:?}"
                );
            }
            assert_eq!(current_index(&chapters, 47.375), Some(1));
        }
        let (source, ssh) = fixture("no-chapters.m4b");
        assert!(probe(source, ssh).unwrap().is_empty());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn m4b_chapter_resume_uses_existing_sqlite_web_history() {
        use crate::media::history::{History, Identity, WebHistory};
        let (source, ssh) = fixture("book.m4b");
        let identity = Identity::from_source(&source);
        let chapters = probe(source, ssh).unwrap();
        let root = std::env::temp_dir().join(format!("vw-m4b-chapters-{}", uuid::Uuid::new_v4()));
        let database = root.join("media-history.sqlite3");
        let history = Arc::new(History::default());
        history.configure(database.clone());
        let web = WebHistory::new(Arc::clone(&history));
        assert_eq!(web.open("book".into(), identity.clone()), None);
        web.update("book", 47.375, 120.0, "pause");
        history.flush();
        assert_eq!(history.lookup(identity.clone()), Some(47.375));
        web.update("book", 49.125, 120.0, "close");
        history.flush();
        drop(web);
        drop(history);
        let history = Arc::new(History::default());
        history.configure(database);
        let web = WebHistory::new(Arc::clone(&history));
        let restored = web.open("reopened".into(), identity.clone()).unwrap();
        assert_eq!(restored, 49.125);
        assert_eq!(current_index(&chapters, restored), Some(1));
        assert_ne!(restored, chapters[1].start_time);
        web.update("reopened", 51.5, 120.0, "tick");
        web.close_all();
        history.flush();
        assert_eq!(web.open("completed".into(), identity.clone()), Some(51.5));
        web.update("completed", 120.0, 120.0, "eof");
        history.flush();
        assert_eq!(history.lookup(identity.clone()), None);
        web.update("completed", 0.0, 120.0, "close");
        history.flush();
        assert_eq!(history.lookup(identity), None);
        drop(web);
        drop(history);
        std::fs::remove_dir_all(root).unwrap();
    }
}
