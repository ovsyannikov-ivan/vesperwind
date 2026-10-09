use std::{
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Local-network privacy starts on macOS 15. Keep earlier supported
        // systems launchable even if Network.framework is not installed.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Network");
    }
    println!(
        "cargo:rustc-env=VESPERWIND_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
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
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource.lib is linked only into binary targets. Unit-test
        // executables also import TaskDialogIndirect, so every linked target
        // needs Common Controls v6. Let MSVC embed the same dependency instead
        // of embedding a second manifest in Tauri's binary-only resources.
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("Tauri Windows build resources");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        // Vendored OpenSSL (openssl-src via libssh2-sys) is compiled with /Zi
        // but its ossl_static.pdb is not installed, so MSVC reports LNK4099
        // ("PDB was not found ... linking object as if no debug info") for
        // every libcrypto object of every linked target. Only that diagnostic
        // is ignored; other linker warnings remain visible.
        println!("cargo:rustc-link-arg=/IGNORE:4099");
        println!("cargo:rerun-if-changed=windows-compatibility.manifest");
        let compatibility =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-compatibility.manifest");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            compatibility.display()
        );
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    } else {
        tauri_build::build()
    }
}
