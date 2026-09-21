use super::success;
use crate::{mpv::PlayerGeometry, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    filesystem_id: Option<String>,
    path: String,
    #[serde(default)]
    autoplay: bool,
    geometry: PlayerGeometry,
}

#[derive(Debug, Deserialize)]
pub struct SeekPayload {
    seconds: f64,
}

#[derive(Debug, Deserialize)]
pub struct VolumePayload {
    volume: f64,
}

#[derive(Debug, Deserialize)]
pub struct MutedPayload {
    muted: bool,
}

#[derive(Debug, Deserialize)]
pub struct TrackPayload {
    kind: String,
    id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SubtitleDelayPayload {
    seconds: f64,
}

#[derive(Debug, Deserialize)]
pub struct GeometryPayload {
    geometry: PlayerGeometry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
pub struct OverlayPayload {
    visible: bool,
    geometry: Option<OverlayGeometry>,
    #[serde(default)]
    context: Value,
}

fn response(result: Result<crate::mpv::PlayerSnapshot, String>) -> Value {
    match result {
        Ok(state) => success("state", state),
        Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
    }
}

#[tauri::command]
pub fn player_capabilities() -> Value {
    success("capabilities", crate::mpv::MpvApi::capabilities())
}

#[tauri::command]
pub fn player_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: OpenPayload,
) -> Value {
    response(state.player.open(
        &state.filesystem,
        &window,
        &app,
        payload.filesystem_id.as_deref(),
        &payload.path,
        payload.autoplay,
        payload.geometry,
    ))
}

#[tauri::command]
pub fn player_play(state: State<'_, AppState>) -> Value {
    response(state.player.play())
}

#[tauri::command]
pub fn player_pause(state: State<'_, AppState>) -> Value {
    response(state.player.pause())
}

#[tauri::command]
pub fn player_seek(state: State<'_, AppState>, payload: SeekPayload) -> Value {
    response(state.player.seek(payload.seconds))
}

#[tauri::command]
pub fn player_set_volume(state: State<'_, AppState>, payload: VolumePayload) -> Value {
    response(state.player.set_volume(payload.volume))
}

#[tauri::command]
pub fn player_set_muted(state: State<'_, AppState>, payload: MutedPayload) -> Value {
    response(state.player.set_muted(payload.muted))
}

#[tauri::command]
pub fn player_select_track(state: State<'_, AppState>, payload: TrackPayload) -> Value {
    response(state.player.select_track(payload.kind, payload.id))
}

#[tauri::command]
pub fn player_set_subtitle_delay(
    state: State<'_, AppState>,
    payload: SubtitleDelayPayload,
) -> Value {
    response(state.player.set_subtitle_delay(payload.seconds))
}

#[tauri::command]
pub fn player_set_geometry(state: State<'_, AppState>, payload: GeometryPayload) -> Value {
    match state.player.set_geometry(payload.geometry) {
        Ok(()) => json!({"ok":true}),
        Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
    }
}

#[tauri::command]
pub fn player_set_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: OverlayPayload,
) -> Value {
    let Some(overlay) = app.get_webview("media-overlay") else {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":"Media overlay WebView is unavailable"}});
    };

    let geometry = if payload.visible {
        payload.geometry.unwrap_or(OverlayGeometry {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        })
    } else {
        OverlayGeometry {
            x: -10_000.0,
            y: -10_000.0,
            width: 1.0,
            height: 1.0,
        }
    };
    let titlebar_offset = app
        .get_webview_window("main")
        .and_then(|window| {
            let scale = window.scale_factor().ok()?;
            let outer = window.outer_size().ok()?;
            let inner = window.inner_size().ok()?;
            Some((outer.height.saturating_sub(inner.height)) as f64 / scale)
        })
        .unwrap_or(0.0);
    if let Err(error) = overlay.set_position(tauri::LogicalPosition::new(
        geometry.x,
        (geometry.y - titlebar_offset).max(0.0),
    )) {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
    }
    if let Err(error) = overlay.set_size(tauri::LogicalSize::new(
        geometry.width.max(1.0),
        geometry.height.max(1.0),
    )) {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
    }

    state.player.set_overlay_context(payload.context.clone());
    if payload.visible {
        let _ = app.emit_to("media-overlay", "media-overlay:context", payload.context);
    }
    json!({"ok":true})
}

#[tauri::command]
pub fn player_overlay_snapshot(state: State<'_, AppState>) -> Value {
    success("context", state.player.overlay_context())
}

#[tauri::command]
pub fn player_snapshot(state: State<'_, AppState>) -> Value {
    response(state.player.snapshot())
}

#[tauri::command]
pub fn player_close(app: AppHandle, state: State<'_, AppState>) -> Value {
    state.player.close();
    if let Some(overlay) = app.get_webview("media-overlay") {
        let _ = overlay.set_position(tauri::LogicalPosition::new(-10_000.0, -10_000.0));
        let _ = overlay.set_size(tauri::LogicalSize::new(1.0, 1.0));
    }
    json!({"ok":true})
}
