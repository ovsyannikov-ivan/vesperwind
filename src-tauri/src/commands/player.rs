use super::success;
use crate::{
    mpv::{MediaKind, PlayerGeometry},
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
#[cfg(target_os = "macos")]
use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    session_id: String,
    #[serde(flatten)]
    source: crate::media::source::MediaSource,
    #[serde(default)]
    autoplay: bool,
    geometry: Option<PlayerGeometry>,
    #[serde(default)]
    kind: MediaKind,
    #[serde(default = "history_enabled_default")]
    history_enabled: bool,
}

fn history_enabled_default() -> bool {
    true
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
    #[serde(default = "default_overlay_scale")]
    scale_factor: f64,
}

fn default_overlay_scale() -> f64 {
    1.0
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityPayload {
    session_id: String,
    visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionCoverPayload {
    covered: bool,
    #[serde(default)]
    duration_ms: u64,
}

// libmpv and native child-window APIs may wait on the window message pump.
// Keep every such wait off the pump and off the async executor threads.
async fn player_task(task: impl FnOnce() -> Value + Send + 'static) -> Value {
    tauri::async_runtime::spawn_blocking(task).await.unwrap_or_else(|error| {
        eprintln!("[player] command worker failed: {error}");
        json!({"ok":false,"error":{"code":"EMPV","message":"The media command could not complete"}})
    })
}

fn response(session_id: &str, result: Result<crate::mpv::PlayerSnapshot, String>) -> Value {
    match result {
        Ok(state) => json!({"ok":true,"sessionId":session_id,"state":state}),
        Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
    }
}

#[tauri::command]
pub async fn player_capabilities() -> Value {
    player_task(move || {
        let capabilities = crate::mpv::MpvApi::capabilities();
        eprintln!("[player] capabilities requested: {capabilities:?}");
        success("capabilities", capabilities)
    })
    .await
}

#[tauri::command]
pub async fn player_open(app: AppHandle, payload: OpenPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        let Some(window) = app.get_window("main") else {
            return json!({"ok":false,"error":{"code":"EMPV_WINDOW","message":"The main native window is unavailable"}});
        };
        if payload.kind == MediaKind::Video {
            if let Err(message) = crate::ensure_media_overlay(&app) { return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":message}}); }
        }
        response(
            &payload.session_id,
            state.player.open(
                &state.filesystem,
                &window,
                &app,
                &payload.session_id,
                &payload.source,
                payload.autoplay,
                payload.geometry,
                payload.kind,
                payload.history_enabled,
            ),
        )

    })
    .await
}

#[tauri::command]
pub async fn player_play(app: AppHandle, payload: SessionPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(&payload.session_id, state.player.play(&payload.session_id))
    })
    .await
}

#[tauri::command]
pub async fn player_pause(app: AppHandle, payload: SessionPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(&payload.session_id, state.player.pause(&payload.session_id))
    })
    .await
}

#[tauri::command]
pub async fn player_seek(app: AppHandle, payload: SeekPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state.player.seek(&payload.session_id, payload.seconds),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_set_volume(app: AppHandle, payload: VolumePayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state.player.set_volume(&payload.session_id, payload.volume),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_set_muted(app: AppHandle, payload: MutedPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state.player.set_muted(&payload.session_id, payload.muted),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_select_track(app: AppHandle, payload: TrackPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state
                .player
                .select_track(&payload.session_id, payload.kind, payload.id),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_set_subtitle_delay(app: AppHandle, payload: SubtitleDelayPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state
                .player
                .set_subtitle_delay(&payload.session_id, payload.seconds),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_set_geometry(app: AppHandle, payload: GeometryPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        match state
            .player
            .set_geometry(&payload.session_id, payload.geometry)
        {
            Ok(()) => json!({"ok":true}),
            Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
        }
    })
    .await
}

#[tauri::command]
pub async fn player_set_visible(app: AppHandle, payload: VisibilityPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        match state
            .player
            .set_visible(&payload.session_id, payload.visible)
        {
            Ok(()) => json!({"ok":true}),
            Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
        }
    })
    .await
}

// Not tied to a session: a closing viewer must still be able to uncover.
#[tauri::command]
pub async fn player_set_transition_cover(app: AppHandle, payload: TransitionCoverPayload) -> Value {
    player_task(move || {
        let Some(window) = app.get_window("main") else {
            return json!({"ok":false,"error":{"code":"EMPV","message":"Main window is unavailable"}});
        };
        let duration = std::time::Duration::from_millis(payload.duration_ms.min(1_000));
        match crate::mpv::transition_cover::set_cover(&window, payload.covered, duration) {
            Ok(native) => json!({"ok":true,"native":native}),
            Err(message) => json!({"ok":false,"error":{"code":"EMPV","message":message}}),
        }
    })
    .await
}

#[tauri::command]
pub async fn player_set_overlay(app: AppHandle, payload: OverlayPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        if !state.player.is_video(&payload.session_id) { return json!({"ok":false,"error":{"message":"Audio playback has no overlay"}}); }

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
                scale_factor: 1.0,
            })
        } else {
            OverlayGeometry {
                x: -10_000.0,
                y: -10_000.0,
                width: 1.0,
                height: 1.0,
                scale_factor: 1.0,
            }
        };
        let titlebar_offset = overlay_titlebar_offset(&app);
        let transitioning = visible
            && payload
                .context
                .get("transitioning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let border_inset = if visible
            && !transitioning
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
        let window_scale = overlay.window().scale_factor().unwrap_or(1.0);
        // One native frame change: separate position and size updates expose
        // the old-size WebView at the new origin for a composited frame.
        if let Err(error) = overlay.set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(
                geometry.x * geometry.scale_factor,
                geometry.y.max(0.0) * geometry.scale_factor,
            )
            .into(),
            size: tauri::PhysicalSize::new(
                (geometry.width * geometry.scale_factor).max(1.0),
                (geometry.height * geometry.scale_factor
                    + (titlebar_offset - border_inset) * window_scale)
                    .max(1.0),
            )
            .into(),
        }) {
            return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
        }

        // During fullscreen changes the opaque cover fills the parent before the
        // video grows. Follow native resize events rather than waiting for JS IPC.
        if let Err(error) = overlay.set_auto_resize(transitioning) {
            return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":error.to_string()}});
        }

        #[cfg(target_os = "windows")]
        if visible {
            let radius = payload
                .context
                .get("borderRadius")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if let Err(message) = raise_windows_overlay(&overlay, radius) {
                return json!({"ok":false,"error":{"code":"EMPV_OVERLAY","message":message}});
            }
        }

        state
            .player
            .set_overlay_context(&payload.session_id, payload.context.clone());
        if visible {
            let _ = app.emit_to("media-overlay", "media-overlay:context", payload.context);
        }
        json!({"ok":true})

    })
    .await
}

#[cfg(target_os = "macos")]
fn overlay_titlebar_offset(app: &AppHandle) -> f64 {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let main_app = app.clone();
    if app
        .run_on_main_thread(move || {
            let offset = main_app
                .get_window("main")
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
                .unwrap_or(0.0);
            let _ = sender.send(offset);
        })
        .is_err()
    {
        return 0.0;
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap_or(0.0)
}

#[cfg(target_os = "windows")]
fn raise_windows_overlay(overlay: &tauri::Webview, radius: f64) -> Result<(), String> {
    use std::{sync::mpsc, time::Duration};
    use windows::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let radius = radius
        * overlay
            .window()
            .scale_factor()
            .map_err(|error| error.to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    overlay
        .with_webview(move |platform| {
            let result = (|| {
                // This is Wry's child container, not the application's main
                // HWND. Keep it above the separate video child and directly
                // below a visible transition cover.
                let mut container = HWND::default();
                unsafe { platform.controller().ParentWindow(&mut container) }
                    .map_err(|error| error.to_string())?;
                let insert_after = crate::mpv::transition_cover::cover_window()
                    .filter(|cover| unsafe { IsWindowVisible(*cover) } != 0)
                    .unwrap_or(HWND_TOP);
                if container.0.is_null()
                    || unsafe {
                        SetWindowPos(
                            container.0,
                            insert_after,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        )
                    } == 0
                {
                    return Err("Unable to raise the media overlay child window".to_string());
                }
                crate::mpv::set_window_clip(container.0, radius)?;
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?
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
                    order_macos_overlay(&parent, view);
                }
                eprintln!(
                    "[overlay] WKWebView native transparency opaque_before={was_opaque} opaque_after={}",
                    view.isOpaque()
                );
            }
        })
        .map_err(|error| error.to_string())
}

// Keep the controls above the video surface and below a visible transition
// cover. Re-inserting a WKWebView that is already in place detaches it from
// the window for a moment, so reorder only when the order is wrong.
#[cfg(target_os = "macos")]
fn order_macos_overlay(parent: &NSView, view: &WKWebView) {
    let subviews = parent.subviews();
    let index_of = |target: *const NSView| {
        (0..subviews.count()).find(|index| std::ptr::eq(&*subviews.objectAtIndex(*index), target))
    };
    let Some(overlay_index) = index_of(view as *const WKWebView as *const NSView) else {
        return;
    };
    let cover = crate::mpv::transition_cover::cover_view()
        .map(|cover| unsafe { &*(cover as *const NSView) })
        .filter(|cover| !cover.isHidden())
        .and_then(|cover| index_of(cover).map(|index| (cover, index)));
    match cover {
        Some((cover, cover_index)) if overlay_index + 1 != cover_index => {
            parent.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Below, Some(cover))
        }
        None if overlay_index + 1 != subviews.count() => {
            parent.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Above, None)
        }
        _ => {}
    }
}

#[tauri::command]
pub fn player_overlay_snapshot(state: State<'_, AppState>) -> Value {
    success("context", state.player.overlay_context_snapshot())
}

#[tauri::command]
pub async fn player_snapshot(app: AppHandle, payload: SessionPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        response(
            &payload.session_id,
            state.player.snapshot(&payload.session_id),
        )
    })
    .await
}

#[tauri::command]
pub async fn player_close(app: AppHandle, payload: SessionPayload) -> Value {
    player_task(move || {
        let state = app.state::<AppState>();
        let video = state.player.is_video(&payload.session_id);
        let closed = state.player.close(&payload.session_id);
        if closed && video {
            if let Some(overlay) = app.get_webview("media-overlay") {
                let _ = overlay.set_auto_resize(false);
                let _ = overlay.set_position(tauri::LogicalPosition::new(-10_000.0, -10_000.0));
                let _ = overlay.set_size(tauri::LogicalSize::new(1.0, 1.0));
            }
        }
        json!({"ok":true,"sessionId":payload.session_id,"closed":closed})
    })
    .await
}

#[cfg(test)]
mod audio_contract_tests {
    use super::*;
    #[test]
    fn audio_open_has_semantic_kind_optional_geometry_and_history_opt_out() {
        let audio: OpenPayload = serde_json::from_value(json!({
            "sessionId":"audio", "kind":"audio", "path":"/book.m4b", "historyEnabled":false, "autoplay":true
        })).unwrap();
        assert_eq!(audio.kind, MediaKind::Audio);
        assert!(audio.geometry.is_none());
        assert!(!audio.history_enabled);
        let normal: OpenPayload = serde_json::from_value(
            json!({"sessionId":"audio", "kind":"audio", "path":"/song.ac3"}),
        )
        .unwrap();
        assert!(normal.history_enabled);
        let video: OpenPayload =
            serde_json::from_value(json!({"sessionId":"video", "path":"/video.mkv"})).unwrap();
        assert_eq!(video.kind, MediaKind::Video);
        assert!(serde_json::from_value::<OpenPayload>(
            json!({"sessionId":"bad", "kind":"guess", "path":"/unknown"})
        )
        .is_err());
    }
}
