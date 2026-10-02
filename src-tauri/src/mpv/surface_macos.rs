//! Keep the established FP16 OpenGL surface independent from owned Metal VO.
#[path = "surface_metal_macos.rs"]
mod metal;
#[path = "surface_opengl_macos.rs"]
mod opengl;
use super::{DisplayCapabilities, PlayerGeometry};
use std::{
    ffi::{c_char, c_void},
    sync::MutexGuard,
};
use tauri::Window;

#[derive(Clone)]
pub enum NativeSurface {
    OpenGl(opengl::NativeSurface),
    Metal(metal::MetalSurface),
}
macro_rules! forward {
    ($self:ident, $method:ident $(, $arg:expr)*) => {
        match $self { Self::OpenGl(s) => s.$method($($arg),*), Self::Metal(s) => s.$method($($arg),*) }
    }
}
impl NativeSurface {
    pub fn create(window: &Window) -> Result<Self, String> {
        opengl::NativeSurface::create(window).map(Self::OpenGl)
    }
    pub fn create_video_host(window: &Window) -> Result<Self, String> {
        metal::MetalSurface::create(window).map(Self::Metal)
    }
    pub fn host_address(&self) -> usize {
        match self {
            Self::Metal(s) => s.host_address(),
            Self::OpenGl(_) => 0,
        }
    }
    pub fn set_geometry(&self, geometry: PlayerGeometry) -> Result<(), String> {
        forward!(self, set_geometry, geometry)
    }
    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        forward!(self, set_visible, visible)
    }
    pub fn retire(&self) {
        if let Self::Metal(surface) = self {
            surface.retire();
        }
    }
    pub fn set_transition_visible(&self, visible: bool) -> Result<(), String> {
        forward!(self, set_transition_visible, visible)
    }
    pub fn is_visible(&self) -> bool {
        forward!(self, is_visible)
    }
    pub fn take_geometry_changed(&self) -> bool {
        forward!(self, take_geometry_changed)
    }
    pub fn refresh_display_capabilities(&self) {
        forward!(self, refresh_display_capabilities)
    }
    pub fn display_capabilities(&self) -> DisplayCapabilities {
        forward!(self, display_capabilities)
    }
    pub fn pixel_size(&self) -> (i32, i32) {
        forward!(self, pixel_size)
    }
    pub fn framebuffer_internal_format(&self) -> i32 {
        match self {
            Self::OpenGl(s) => s.framebuffer_internal_format(),
            Self::Metal(_) => 0,
        }
    }
    pub fn framebuffer_depth(&self) -> i32 {
        match self {
            Self::OpenGl(s) => s.framebuffer_depth(),
            Self::Metal(_) => 0,
        }
    }
    pub fn make_current(&self) -> Result<(), String> {
        match self {
            Self::OpenGl(s) => s.make_current(),
            Self::Metal(_) => Err("Owned Metal presentation has no caller OpenGL context".into()),
        }
    }
    pub fn lock_context(&self) -> MutexGuard<'_, ()> {
        forward!(self, lock_context)
    }
    pub fn clear_current(&self) {
        if let Self::OpenGl(s) = self {
            s.clear_current()
        }
    }
    pub fn swap_buffers(&self) {
        if let Self::OpenGl(s) = self {
            s.swap_buffers()
        }
    }
    pub unsafe fn get_proc_address(&self, name: *const c_char) -> *mut c_void {
        match self {
            Self::OpenGl(s) => unsafe { s.get_proc_address(name) },
            Self::Metal(_) => std::ptr::null_mut(),
        }
    }
}
