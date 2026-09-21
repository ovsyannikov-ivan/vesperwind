#[cfg(target_os = "macos")]
#[path = "surface_macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "surface_windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{DisplayCapabilities, PlayerGeometry};
    use std::{
        ffi::{c_char, c_void},
        sync::{Arc, Mutex, MutexGuard},
    };
    use tauri::WebviewWindow;
    #[derive(Clone)]
    pub struct NativeSurface(Arc<Mutex<()>>);
    impl NativeSurface {
        pub fn create(_: &WebviewWindow) -> Result<Self, String> {
            Err("Native video surfaces are unsupported on this platform".into())
        }
        pub fn set_geometry(&self, _: PlayerGeometry) -> Result<(), String> {
            Ok(())
        }
        pub fn set_visible(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
        pub fn is_visible(&self) -> bool {
            false
        }
        pub fn take_geometry_changed(&self) -> bool {
            false
        }
        pub fn refresh_display_capabilities(&self) {}
        pub fn display_capabilities(&self) -> DisplayCapabilities {
            DisplayCapabilities {
                platform: std::env::consts::OS.to_string(),
                surface_format: "unsupported".to_string(),
                output_supported: false,
                reason: Some("Native HDR output is unsupported on this platform".to_string()),
                ..DisplayCapabilities::default()
            }
        }
        pub fn framebuffer_internal_format(&self) -> i32 {
            0
        }
        pub fn framebuffer_depth(&self) -> i32 {
            8
        }
        pub fn pixel_size(&self) -> (i32, i32) {
            (0, 0)
        }
        pub fn make_current(&self) -> Result<(), String> {
            Err("unsupported".into())
        }
        pub fn lock_context(&self) -> MutexGuard<'_, ()> {
            self.0.lock().unwrap_or_else(|error| error.into_inner())
        }
        pub fn clear_current(&self) {}
        pub fn swap_buffers(&self) {}
        pub unsafe fn get_proc_address(&self, _: *const c_char) -> *mut c_void {
            std::ptr::null_mut()
        }
    }
}

use super::player::PlayerGeometry;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayCapabilities {
    pub platform: String,
    pub hdr_capable: bool,
    pub hdr_enabled: bool,
    pub output_supported: bool,
    pub surface_format: String,
    pub current_headroom: f64,
    pub potential_headroom: f64,
    pub max_luminance_nits: Option<f64>,
    pub max_full_frame_luminance_nits: Option<f64>,
    pub sdr_white_nits: Option<f64>,
    pub bits_per_color: Option<u32>,
    pub reason: Option<String>,
}

pub(crate) use platform::NativeSurface;

pub(crate) const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));
