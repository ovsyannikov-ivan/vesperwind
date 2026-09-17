use serde_json::{json, Value};

#[tauri::command]
pub fn runtime_info() -> Value {
    json!({
        "ok": true,
        "runtime": "tauri",
        "version": env!("CARGO_PKG_VERSION"),
        "buildTimestamp": env!("VESPERWIND_BUILD_TIMESTAMP"),
        "gitCommit": env!("VESPERWIND_GIT_SHA"),
    })
}
