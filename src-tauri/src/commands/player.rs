use super::success;
use crate::{mpv::PlayerGeometry, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSColor, NSWindow, NSWindowOrderingMode};
#[cfg(target_os = "macos")]
use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    session_id: String,
    filesystem_id: Option<String>,
    path: String,
    #[serde(default)]
    autoplay: bool,
    geometry: PlayerGeometry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SeekPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    seconds: f64,
}

#[derive(Debug, Deserialize)]
pub struct VolumePayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    volume: f64,
}

#[derive(Debug, Deserialize)]
pub struct MutedPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    muted: bool,
}

#[derive(Debug, Deserialize)]
pub struct TrackPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    kind: String,
    id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SubtitleDelayPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
    seconds: f64,
}

#[derive(Debug, Deserialize)]
pub struct GeometryPayload {
    #[serde(rename = "sessionId")]
    session_id: String,
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
    #[serde(rename = "sessionId")]
    session_id: String,
    visible: bool,
    geometry: Option<OverlayGeometry>,
    #[serde(default)]
    context: Value,
}

fn response(session_id: &str, result: Result<crate::mpv::PlayerSnapshot, String>) -> Value {
    match result {
        Ok(state) => json!({"ok":true,"sessionId":session_id,"state":state}),
        Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
    }
}

#[tauri::command]
pub fn player_capabilities() -> Value {
    let capabilities = crate::mpv::MpvApi::capabilities();
    eprintln!("[player] capabilities requested: {capabilities:?}");
    success("capabilities", capabilities)
}

#[tauri::command]
pub fn player_open(app: AppHandle, state: State<'_, AppState>, payload: OpenPayload) -> Value {
    let Some(window) = app.get_window("main") else {
        return json!({"ok":false,"error":{"code":"EMPV_WINDOW","message":"The main native window is unavailable"}});
    };
    eprintln!(
        "[player={}] command open received provider={} path={:?} geometry={}x{}@{}",
        payload.session_id,
        payload.filesystem_id.as_deref().unwrap_or("local"),
        payload.path,
        payload.geometry.width,
        payload.geometry.height,
        payload.geometry.scale_factor,
    );
    response(
        &payload.session_id,
        state.player.open(
            &state.filesystem,
            &window,
            &app,
            &payload.session_id,
            payload.filesystem_id.as_deref(),
            &payload.path,
            payload.autoplay,
            payload.geometry,
        ),
    )
}

#[tauri::command]
pub fn player_play(state: State<'_, AppState>, payload: SessionPayload) -> Value {
    response(&payload.session_id, state.player.play(&payload.session_id))
}

#[tauri::command]
pub fn player_pause(state: State<'_, AppState>, payload: SessionPayload) -> Value {
    response(&payload.session_id, state.player.pause(&payload.session_id))
}

#[tauri::command]
pub fn player_seek(state: State<'_, AppState>, payload: SeekPayload) -> Value {
    response(
        &payload.session_id,
        state.player.seek(&payload.session_id, payload.seconds),
    )
}

#[tauri::command]
pub fn player_set_volume(state: State<'_, AppState>, payload: VolumePayload) -> Value {
    response(
        &payload.session_id,
        state.player.set_volume(&payload.session_id, payload.volume),
    )
}

#[tauri::command]
pub fn player_set_muted(state: State<'_, AppState>, payload: MutedPayload) -> Value {
    response(
        &payload.session_id,
        state.player.set_muted(&payload.session_id, payload.muted),
    )
}

#[tauri::command]
pub fn player_select_track(state: State<'_, AppState>, payload: TrackPayload) -> Value {
    response(
        &payload.session_id,
        state
            .player
            .select_track(&payload.session_id, payload.kind, payload.id),
    )
}

#[tauri::command]
pub fn player_set_subtitle_delay(
    state: State<'_, AppState>,
    payload: SubtitleDelayPayload,
) -> Value {
    response(
        &payload.session_id,
        state
            .player
            .set_subtitle_delay(&payload.session_id, payload.seconds),
    )
}

#[tauri::command]
pub fn player_set_geometry(state: State<'_, AppState>, payload: GeometryPayload) -> Value {
    match state
        .player
        .set_geometry(&payload.session_id, payload.geometry)
    {
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
    if let Err(message) = state.player.assert_session(&payload.session_id) {
        return json!({"ok":false,"error":{"code":"EMPV","message":message}});
    }
    let Some(overlay) = app.get_webview("media-overlay") else {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":"Media overlay WebView is unavailable"}});
    };

    #[cfg(target_os = "macos")]
    if let Err(message) = configure_macos_overlay(&overlay) {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":message}});
    }

    let developer_hidden = std::env::var_os("VESPERWIND_MPV_DEBUG_HIDE_OVERLAY").is_some();
    let visible = payload.visible && !developer_hidden;
    if payload.visible && developer_hidden {
        eprintln!(
            "[player={}] developer overlay toggle: child WKWebView parked offscreen",
            payload.session_id
        );
    }
    let geometry = if visible {
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
    let titlebar_offset = overlay_titlebar_offset(&app);
    let border_inset = if visible
        && !payload
            .context
            .get("fullscreen")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        1.0
    } else {
        0.0
    };
    if let Err(error) =
        overlay.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y.max(0.0)))
    {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
    }
    if let Err(error) = overlay.set_size(tauri::LogicalSize::new(
        geometry.width.max(1.0),
        (geometry.height + titlebar_offset - border_inset).max(1.0),
    )) {
        return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
    }

    state
        .player
        .set_overlay_context(&payload.session_id, payload.context.clone());
    if visible {
        let _ = app.emit_to("media-overlay", "media-overlay:context", payload.context);
    }
    json!({"ok":true})
}

#[cfg(target_os = "macos")]
fn overlay_titlebar_offset(app: &AppHandle) -> f64 {
    app.get_window("main")
        .and_then(|window| {
            let pointer = window.ns_window().ok()?;
            if pointer.is_null() {
                return None;
            }
            let window = unsafe { &*(pointer as *const NSWindow) };
            let frame_height = window.frame().size.height;
            let content_height = window.contentLayoutRect().size.height;
            Some((frame_height - content_height).max(0.0))
        })
        .unwrap_or(0.0)
}

#[cfg(not(target_os = "macos"))]
fn overlay_titlebar_offset(_: &AppHandle) -> f64 {
    0.0
}

#[cfg(target_os = "macos")]
fn configure_macos_overlay(overlay: &tauri::Webview) -> Result<(), String> {
    overlay
        .with_webview(move |platform| {
            unsafe {
                let view = &*(platform.inner() as *const WKWebView);
                let was_opaque = view.isOpaque();
                let no = NSNumber::numberWithBool(false);
                view.setValue_forKey(Some(&no), ns_string!("drawsBackground"));
                view.setUnderPageBackgroundColor(Some(&NSColor::clearColor()));
                view.setWantsLayer(true);
                if let Some(parent) = view.superview() {
                    parent.setWantsLayer(true);
                    parent.addSubview_positioned_relativeTo(
                        view,
                        NSWindowOrderingMode::Above,
                        None,
                    );
                }
                eprintln!(
                    "[overlay] WKWebView native transparency opaque_before={was_opaque} opaque_after={} reordered_above_siblings=true",
                    view.isOpaque()
                );
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn player_overlay_snapshot(state: State<'_, AppState>) -> Value {
    success("context", state.player.overlay_context_snapshot())
}

#[tauri::command]
pub fn player_snapshot(state: State<'_, AppState>, payload: SessionPayload) -> Value {
    response(
        &payload.session_id,
        state.player.snapshot(&payload.session_id),
    )
}

#[tauri::command]
pub fn player_close(app: AppHandle, state: State<'_, AppState>, payload: SessionPayload) -> Value {
    let closed = state.player.close(&payload.session_id);
    if closed {
        if let Some(overlay) = app.get_webview("media-overlay") {
            let _ = overlay.set_position(tauri::LogicalPosition::new(-10_000.0, -10_000.0));
            let _ = overlay.set_size(tauri::LogicalSize::new(1.0, 1.0));
        }
    }
    json!({"ok":true,"sessionId":payload.session_id,"closed":closed})
}
