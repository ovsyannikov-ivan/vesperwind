//! Debug-only driver for the actual main/overlay WebViews; no alternative player.
use serde_json::Value;
use std::path::PathBuf;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::Listener;

pub fn config() -> Option<Value> {
    if std::env::args().nth(1).as_deref() != Some("--media-ui-regression") {
        return None;
    }
    let file = PathBuf::from(std::env::args().nth(2)?);
    let bytes = std::fs::read(file).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if !value["endpoint"].as_str()?.starts_with("http://127.0.0.1:") {
        return None;
    }
    Some(value)
}
pub fn history_path() -> Option<PathBuf> {
    let value = config()?;
    let path = PathBuf::from(value["profile"].as_str()?);
    if !path.is_absolute() {
        return None;
    }
    Some(path.join("media-history.sqlite3"))
}
pub fn page_loaded(webview: &tauri::Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    if !matches!(webview.label(), "main" | "media-overlay") {
        return;
    }
    let Some(mut value) = config() else {
        return;
    };
    value["label"] = webview.label().into();
    value["pid"] = std::process::id().into();
    eprintln!("[media-ui-regression] attach {}", webview.label());
    let script = format!(
        "window.__MEDIA_PROBE_CONFIG__={};\n{}",
        value,
        include_str!("../../scripts/media-native-driver.js")
    );
    if let Err(error) = webview.eval(script) {
        eprintln!("Native media UI driver failed: {error}");
    }
}

pub fn setup(app: &tauri::AppHandle) {
    if config().is_none() {
        return;
    }
    let quit = app.clone();
    app.listen("media-ui-regression:quit", move |_| quit.exit(0));
}
