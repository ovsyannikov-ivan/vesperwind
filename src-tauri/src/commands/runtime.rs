use serde_json::{json, Value};

#[tauri::command]
pub fn runtime_info() -> Value {
    json!({
        "ok": true,
        "runtime": "tauri",
        "mode": "tauri",
        "isStandalone": true,
        "version": env!("CARGO_PKG_VERSION"),
        "buildTimestamp": env!("VESPERWIND_BUILD_TIMESTAMP"),
        "gitCommit": env!("VESPERWIND_GIT_SHA"),
    })
}

#[cfg(test)]
mod tests {
    use super::runtime_info;

    #[test]
    fn reports_the_centralized_tauri_runtime_mode() {
        let info = runtime_info();

        assert_eq!(info["runtime"], "tauri");
        assert_eq!(info["mode"], "tauri");
        assert_eq!(info["isStandalone"], true);
    }
}
