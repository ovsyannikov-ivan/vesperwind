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
