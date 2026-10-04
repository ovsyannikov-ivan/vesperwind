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
    provider_id: Option<String>,
    path: String,
}

// Bound probes across all WebViews, including Quick Look and the playlist.
static METADATA_PROBES: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());
struct ProbePermit;
impl ProbePermit {
    fn acquire() -> Self {
        let (mutex, ready) = &METADATA_PROBES;
        let mut active = mutex.lock().unwrap_or_else(|v| v.into_inner());
        while *active >= 2 {
            active = ready.wait(active).unwrap_or_else(|v| v.into_inner());
        }
        *active += 1;
        Self
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
) -> crate::mpv::chapters::SourceMetadata {
    use tauri::Manager;
    let metadata = tauri::async_runtime::spawn_blocking(move || {
        let _permit = ProbePermit::acquire();
        let state = app.state::<AppState>();
        crate::provider_content::ContentSource::open(
            &state.filesystem,
            &state.ssh,
            payload.provider_id.as_deref(),
            &payload.path,
        )
        .ok()
        .and_then(|source| {
            crate::mpv::chapters::probe_metadata(source, std::sync::Arc::clone(&state.ssh)).ok()
        })
        .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    metadata
}

#[tauri::command]
pub async fn media_metadata(app: tauri::AppHandle, payload: ChapterPayload) -> Value {
    let metadata = source_metadata(app, payload).await;
    serde_json::json!({"ok":true,"duration":metadata.duration,"chapters":metadata.chapters})
}

#[tauri::command]
pub async fn media_chapters(app: tauri::AppHandle, payload: ChapterPayload) -> Value {
    success("chapters", source_metadata(app, payload).await.chapters)
}
