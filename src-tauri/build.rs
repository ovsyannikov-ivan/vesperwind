use std::{
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let git_sha = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unavailable".to_string());

    println!("cargo:rustc-env=VESPERWIND_BUILD_TIMESTAMP={timestamp}");
    println!("cargo:rustc-env=VESPERWIND_GIT_SHA={git_sha}");
    println!("cargo:rerun-if-env-changed=VESPERWIND_BUILD_NONCE");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
