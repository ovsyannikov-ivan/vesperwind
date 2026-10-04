use super::success;
use crate::AppState;
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSourcePayload {
    filesystem_id: Option<String>,
    path: Option<String>,
}

#[tauri::command]
pub fn media_source(state: State<'_, AppState>, payload: MediaSourcePayload) -> Value {
    success(
        "source",
        state.media_http.source(
            payload.filesystem_id.as_deref(),
            payload.path.as_deref().unwrap_or_default(),
        ),
    )
}

#[tauri::command]
pub async fn video_thumbnail(
    app: tauri::AppHandle,
    payload: crate::media::thumbnail::ThumbnailRequest,
) -> Value {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match state.thumbnails.generate(&state.filesystem, payload) {
            Ok(thumbnail) => success("thumbnail", thumbnail),
            Err(error) => super::failure(error),
        }
    })
    .await
    .unwrap_or_else(|_| {
        super::failure(crate::error::NativeError::new(
            "ETHUMBNAIL",
            "Thumbnail worker failed",
        ))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPayload {
    session_id: String,
    event: String,
    path: Option<String>,
    provider_id: Option<String>,
    position: Option<f64>,
    duration: Option<f64>,
}
#[tauri::command]
pub async fn media_history(app: tauri::AppHandle, payload: HistoryPayload) -> Value {
    use tauri::Manager;
    if payload.event != "open" {
        let state = app.state::<AppState>();
        state.web_history.update(
            &payload.session_id,
            payload.position.unwrap_or(0.0),
            payload.duration.unwrap_or(0.0),
            &payload.event,
        );
        return serde_json::json!({"ok":true});
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match crate::provider_content::ContentSource::open(
            &state.filesystem,
            &state.ssh,
            payload.provider_id.as_deref(),
            payload.path.as_deref().unwrap_or_default(),
        ) {
            Ok(source) => {
                let resume = state.web_history.open(
                    payload.session_id,
                    crate::media::history::Identity::from_source(&source),
                );
                serde_json::json!({"ok":true,"position":resume})
            }
            Err(error) => super::failure(error),
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"ok":false}))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPayload {
    #[serde(flatten)]
    source: crate::media::source::MediaSource,
    probe_id: Option<String>,
}

// Bound probes across all WebViews, including Quick Look and the playlist.
static METADATA_PROBES: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());
struct ProbePermit;
impl ProbePermit {
    fn acquire(cancelled: &std::sync::atomic::AtomicBool) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        let (mutex, ready) = &METADATA_PROBES;
        let mut active = mutex.lock().unwrap_or_else(|v| v.into_inner());
        while *active >= 2 {
            if cancelled.load(std::sync::atomic::Ordering::Acquire)
                || std::time::Instant::now() >= deadline
            {
                return Err("Metadata probe cancelled or timed out".into());
            }
            active = ready
                .wait_timeout(active, std::time::Duration::from_millis(100))
                .unwrap_or_else(|v| v.into_inner())
                .0;
        }
        *active += 1;
        Ok(Self)
    }
}
impl Drop for ProbePermit {
    fn drop(&mut self) {
        *METADATA_PROBES.0.lock().unwrap_or_else(|v| v.into_inner()) -= 1;
        METADATA_PROBES.1.notify_one();
    }
}

async fn source_metadata(
    app: tauri::AppHandle,
    payload: ChapterPayload,
) -> Result<crate::mpv::chapters::SourceMetadata, String> {
    use tauri::Manager;
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let id = payload
        .probe_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    probe_cancellations()
        .lock()
        .unwrap_or_else(|v| v.into_inner())
        .insert(id.clone(), std::sync::Arc::clone(&cancelled));
    let metadata = tauri::async_runtime::spawn_blocking(move || {
        let _permit = ProbePermit::acquire(&cancelled)?;
        let state = app.state::<AppState>();
        let registry =
            crate::mpv::stream::MpvStreamRegistry::new(std::sync::Arc::clone(&state.ssh));
        let resolved = payload
            .source
            .resolve(&state.filesystem, &state.ssh, &registry)?;
        crate::mpv::chapters::probe_uri(&resolved.uri, registry, Some(&cancelled))
    })
    .await
    .unwrap_or_else(|_| Err("Metadata worker failed".into()));
    probe_cancellations()
        .lock()
        .unwrap_or_else(|v| v.into_inner())
        .remove(&id);
    metadata
}

#[tauri::command]
pub async fn media_metadata(app: tauri::AppHandle, payload: ChapterPayload) -> Value {
    let metadata = source_metadata(app, payload).await;
    match metadata {
        Ok(metadata) => {
            let mut value = serde_json::to_value(metadata).unwrap();
            value["ok"] = Value::Bool(true);
            value
        }
        Err(_) => {
            serde_json::json!({"ok":false,"error":{"code":"EMEDIA_PROBE","message":"Unable to inspect this source (unavailable, unsupported, or timed out)"}})
        }
    }
}

#[tauri::command]
pub async fn media_chapters(app: tauri::AppHandle, payload: ChapterPayload) -> Value {
    success(
        "chapters",
        source_metadata(app, payload)
            .await
            .unwrap_or_default()
            .chapters,
    )
}

type ProbeCancellations = std::sync::Mutex<
    std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
>;
fn probe_cancellations() -> &'static ProbeCancellations {
    static PROBES: std::sync::OnceLock<ProbeCancellations> = std::sync::OnceLock::new();
    PROBES.get_or_init(Default::default)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelMetadataPayload {
    probe_id: String,
}
#[tauri::command]
pub fn media_cancel_metadata(payload: CancelMetadataPayload) {
    if let Some(flag) = probe_cancellations()
        .lock()
        .unwrap_or_else(|v| v.into_inner())
        .get(&payload.probe_id)
    {
        flag.store(true, std::sync::atomic::Ordering::Release);
    }
}
