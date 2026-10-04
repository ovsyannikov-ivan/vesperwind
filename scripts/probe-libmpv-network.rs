// Standalone verifier, compiled with the existing Rust build toolchain.
#[path = "../src-tauri/src/mpv/dynamic_library.rs"]
mod dynamic_library;
use std::{
    ffi::{c_char, c_void, CStr},
    path::Path,
};
fn main() {
    let path = std::env::args().nth(1).expect("bundled avformat path");
    let lib = unsafe { dynamic_library::DynamicLibrary::open(Path::new(&path)) }
        .expect("bundled avformat");
    let enumerate: unsafe extern "C" fn(*mut *mut c_void, i32) -> *const c_char =
        unsafe { lib.symbol("avio_enum_protocols") }.unwrap();
    let mut context = std::ptr::null_mut();
    let mut protocols = Vec::new();
    loop {
        let value = unsafe { enumerate(&mut context, 0) };
        if value.is_null() {
            break;
        }
        protocols.push(
            unsafe { CStr::from_ptr(value) }
                .to_str()
                .unwrap()
                .to_owned(),
        );
    }
    for required in ["http", "https", "tls", "hls", "tcp", "crypto", "file"] {
        assert!(
            protocols.iter().any(|s| s == required),
            "Missing bundled protocol: {required}"
        );
    }
    let iterate: unsafe extern "C" fn(*mut *mut c_void) -> *const *const c_char =
        unsafe { lib.symbol("av_demuxer_iterate") }.unwrap();
    let mut context = std::ptr::null_mut();
    let mut hls = false;
    loop {
        let format = unsafe { iterate(&mut context) };
        if format.is_null() {
            break;
        }
        hls |= unsafe { CStr::from_ptr(*format) }
            .to_str()
            .unwrap()
            .split(',')
            .any(|s| s == "hls");
    }
    assert!(hls, "Missing bundled HLS demuxer");
    println!(
        "Verified bundled input protocols: {} and HLS demuxer",
        protocols.join(", ")
    );
}
