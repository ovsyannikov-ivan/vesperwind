//! mpv owns container demuxing for both native playback and HTML media metadata.
use super::{
    stream::MpvStreamRegistry, MpvApi, MpvHandle, MPV_EVENT_END_FILE, MPV_EVENT_FILE_LOADED,
    MPV_EVENT_SHUTDOWN,
};
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

/// No rendering surface, audio device, watch-later files, or system executable.
/// The registry must outlive mpv_destroy (stream callbacks run on mpv threads).
pub(crate) fn probe(source: ContentSource, ssh: Arc<SshManager>) -> Result<Vec<Chapter>, String> {
    let registry = MpvStreamRegistry::new(ssh);
    let uri = registry.register(source);
    let api = MpvApi::load_bundled()?;
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        return Err("mpv_create failed".into());
    }
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
        ] {
            api.set_option(handle, name, value)
                .map_err(|error| format!("{name}={value}: {error}"))?;
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
        api.command(handle, &["loadfile", &uri, "replace"])?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match api.wait_event_details(handle, 0.05).event_id {
                MPV_EVENT_FILE_LOADED => return Ok(read(&api, handle)),
                MPV_EVENT_END_FILE | MPV_EVENT_SHUTDOWN => return Ok(Vec::new()),
                _ => {}
            }
        }
        Err("Chapter metadata load timed out".into())
    })();
    api.destroy(handle);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
