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
