use std::{env, fs, path::PathBuf};

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for name in ["VESPERWIND_PORTABLE_PAYLOAD", "VESPERWIND_PORTABLE_SHA256"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let payload = env::var_os("VESPERWIND_PORTABLE_PAYLOAD")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let path = out.join("empty.payload");
            fs::write(&path, []).unwrap();
            path
        });
    println!("cargo:rerun-if-changed={}", payload.display());
    println!("cargo:rustc-env=PORTABLE_PAYLOAD={}", payload.display());
    println!(
        "cargo:rustc-env=PORTABLE_SHA256={}",
        env::var("VESPERWIND_PORTABLE_SHA256").unwrap_or_default()
    );
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let icon = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("../../src-tauri/icons/icon.ico");
        let rc = out.join("launcher.rc");
        fs::write(
            &rc,
            format!("1 ICON \"{}\"\n", icon.to_string_lossy().replace('\\', "/")),
        )
        .unwrap();
        embed_resource::compile(&rc, embed_resource::NONE)
            .manifest_optional()
            .unwrap();
        let manifest =
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("launcher.manifest");
        println!("cargo:rerun-if-changed=launcher.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
