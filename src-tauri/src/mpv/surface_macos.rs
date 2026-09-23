#![allow(deprecated)]

use super::{DisplayCapabilities, PlayerGeometry};
use objc2::{rc::Retained, AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSOpenGLContext, NSOpenGLPFAAccelerated, NSOpenGLPFAColorFloat, NSOpenGLPFAColorSize,
    NSOpenGLPFADepthSize, NSOpenGLPFADoubleBuffer, NSOpenGLPFAOpenGLProfile,
    NSOpenGLPFAStencilSize, NSOpenGLPixelFormat, NSOpenGLPixelFormatAttribute,
    NSOpenGLProfileVersion4_1Core, NSOpenGLView, NSView, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::CACornerMask;
use std::{
    ffi::{c_char, c_void},
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::Window;

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

const RTLD_DEFAULT: *mut c_void = (-2_isize) as *mut c_void;

struct SurfaceInner {
    window: Window,
    root: usize,
    container: usize,
    view: usize,
    context: usize,
    pixel_width: AtomicI32,
    pixel_height: AtomicI32,
    visible: AtomicBool,
    geometry_changed: AtomicBool,
    gl_lock: Mutex<()>,
    floating_surface: bool,
    current_headroom: AtomicU64,
    potential_headroom: AtomicU64,
}

unsafe impl Send for SurfaceInner {}
unsafe impl Sync for SurfaceInner {}

#[derive(Clone)]
pub struct NativeSurface(Arc<SurfaceInner>);

impl NativeSurface {
    pub fn create(window: &Window) -> Result<Self, String> {
        let root = window.ns_view().map_err(|error| error.to_string())? as usize;
        let (tx, rx) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = (|| -> Result<(usize, usize, usize, bool, f64, f64), String> {
                    let mtm = MainThreadMarker::new().ok_or_else(|| {
                        "Native surface creation was not run on the AppKit main thread".to_string()
                    })?;
                    let root_view = unsafe { &*(root as *const NSView) };
                    // WKWebView is layer-backed. Keep the native video surface in the
                    // same Core Animation hierarchy so the transparent media overlay
                    // can composite above it instead of being flattened to an opaque
                    // black sibling by AppKit.
                    root_view.setWantsLayer(true);
                    let container = NSView::initWithFrame(
                        NSView::alloc(mtm),
                        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
                    );
                    container.setWantsLayer(true);
                    let container_layer = container.layer().ok_or_else(|| {
                        "Unable to create the native video clipping layer".to_string()
                    })?;
                    container_layer.setMaskedCorners(
                        CACornerMask::LayerMinXMinYCorner | CACornerMask::LayerMaxXMinYCorner,
                    );
                    container_layer.setCornerRadius(0.0);
                    container_layer.setMasksToBounds(false);
                    container.setHidden(true);
                    let mut attributes: [NSOpenGLPixelFormatAttribute; 13] = [
                        NSOpenGLPFAOpenGLProfile,
                        NSOpenGLProfileVersion4_1Core,
                        NSOpenGLPFAAccelerated,
                        NSOpenGLPFADoubleBuffer,
                        NSOpenGLPFAColorFloat,
                        NSOpenGLPFAColorSize,
                        64,
                        NSOpenGLPFADepthSize,
                        24,
                        NSOpenGLPFAStencilSize,
                        8,
                        0,
                        0,
                    ];
                    let edr_format = unsafe {
                        NSOpenGLPixelFormat::initWithAttributes(
                            NSOpenGLPixelFormat::alloc(),
                            NonNull::new(attributes.as_mut_ptr()).expect("pixel attributes"),
                        )
                    };
                    let floating_surface = edr_format.is_some();
                    let format =
                        edr_format.unwrap_or_else(|| NSOpenGLView::defaultPixelFormat(mtm));
                    let view = NSOpenGLView::initWithFrame_pixelFormat(
                        NSOpenGLView::alloc(mtm),
                        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
                        Some(&format),
                    )
                    .ok_or_else(|| "Unable to create NSOpenGLView".to_string())?;
                    view.setWantsLayer(true);
                    #[allow(deprecated)]
                    view.setWantsBestResolutionOpenGLSurface(true);
                    #[allow(deprecated)]
                    view.setWantsExtendedDynamicRangeOpenGLSurface(floating_surface);
                    view.setHidden(false);
                    container.addSubview_positioned_relativeTo(
                        &view,
                        NSWindowOrderingMode::Above,
                        None,
                    );
                    root_view.addSubview_positioned_relativeTo(
                        &container,
                        NSWindowOrderingMode::Above,
                        None,
                    );
                    let context = view
                        .openGLContext()
                        .ok_or_else(|| "Unable to create NSOpenGLContext".to_string())?;
                    let (current_headroom, potential_headroom) = display_headroom(&view);
                    Ok((
                        Retained::into_raw(container) as usize,
                        Retained::into_raw(view) as usize,
                        Retained::into_raw(context) as usize,
                        floating_surface,
                        current_headroom,
                        potential_headroom,
                    ))
                })();
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        let (container, view, context, floating_surface, current_headroom, potential_headroom) = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())??;

        Ok(Self(Arc::new(SurfaceInner {
            window: window.clone(),
            root,
            container,
            view,
            context,
            pixel_width: AtomicI32::new(1),
            pixel_height: AtomicI32::new(1),
            visible: AtomicBool::new(false),
            geometry_changed: AtomicBool::new(true),
            gl_lock: Mutex::new(()),
            floating_surface,
            current_headroom: AtomicU64::new(current_headroom.to_bits()),
            potential_headroom: AtomicU64::new(potential_headroom.to_bits()),
        })))
    }

    pub fn set_geometry(&self, geometry: PlayerGeometry) -> Result<(), String> {
        let width = (geometry.width.max(0.0) * geometry.scale_factor.max(1.0)).round() as i32;
        let height = (geometry.height.max(0.0) * geometry.scale_factor.max(1.0)).round() as i32;
        let root = self.0.root;
        let container = self.0.container;
        let view = self.0.view;
        let context = self.0.context;
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                let _gl_guard = inner
                    .gl_lock
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let root_view = unsafe { &*(root as *const NSView) };
                let container_view = unsafe { &*(container as *const NSView) };
                let video_view = unsafe { &*(view as *const NSOpenGLView) };
                let gl_context = unsafe { &*(context as *const NSOpenGLContext) };
                let root_height = root_view.bounds().size.height;
                let viewport_offset_y = geometry
                    .viewport_height
                    .map(|height| (root_height - height).max(0.0))
                    .unwrap_or(0.0);
                let frame = NSRect::new(
                    NSPoint::new(
                        geometry.x,
                        root_height - geometry.y - viewport_offset_y - geometry.height,
                    ),
                    NSSize::new(geometry.width.max(0.0), geometry.height.max(0.0)),
                );
                container_view.setFrame(frame);
                video_view.setFrame(NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(geometry.width.max(0.0), geometry.height.max(0.0)),
                ));
                if let Some(layer) = container_view.layer() {
                    layer.setCornerRadius(geometry.border_radius.max(0.0));
                    layer.setMasksToBounds(geometry.border_radius > 0.0);
                }
                video_view.update();
                gl_context.update(mtm);
                inner.pixel_width.store(width, Ordering::Release);
                inner.pixel_height.store(height, Ordering::Release);
                inner.geometry_changed.store(true, Ordering::Release);
            })
            .map_err(|error| error.to_string())?;
        self.refresh_display_capabilities();
        Ok(())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.0.visible.store(visible, Ordering::Release);
        self.0.geometry_changed.store(true, Ordering::Release);
        let container = self.0.container;
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                let _gl_guard = inner
                    .gl_lock
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let container_view = unsafe { &*(container as *const NSView) };
                container_view.setHidden(!visible);
            })
            .map_err(|error| error.to_string())
    }

    pub fn is_visible(&self) -> bool {
        self.0.visible.load(Ordering::Acquire)
    }
    pub fn take_geometry_changed(&self) -> bool {
        self.0.geometry_changed.swap(false, Ordering::AcqRel)
    }
    pub fn refresh_display_capabilities(&self) {
        let view = self.0.view;
        let inner = Arc::clone(&self.0);
        let _ = self.0.window.run_on_main_thread(move || {
            let video_view = unsafe { &*(view as *const NSOpenGLView) };
            let (current, potential) = display_headroom(video_view);
            inner
                .current_headroom
                .store(current.to_bits(), Ordering::Release);
            inner
                .potential_headroom
                .store(potential.to_bits(), Ordering::Release);
        });
    }
    pub fn display_capabilities(&self) -> DisplayCapabilities {
        let current = f64::from_bits(self.0.current_headroom.load(Ordering::Acquire));
        let potential = f64::from_bits(self.0.potential_headroom.load(Ordering::Acquire));
        let capable = self.0.floating_surface && potential > 1.0;
        DisplayCapabilities {
            platform: "macos".to_string(),
            hdr_capable: capable,
            hdr_enabled: capable && current > 1.0,
            output_supported: self.0.floating_surface,
            surface_format: if self.0.floating_surface {
                "RGBA16F NSOpenGL EDR".to_string()
            } else {
                "default NSOpenGL SDR".to_string()
            },
            current_headroom: current,
            potential_headroom: potential,
            reason: (!self.0.floating_surface).then(|| {
                "AppKit could not create the requested 64-bit floating-point OpenGL pixel format"
                    .to_string()
            }),
            ..DisplayCapabilities::default()
        }
    }
    pub fn framebuffer_internal_format(&self) -> i32 {
        if self.0.floating_surface {
            0x881A
        } else {
            0
        }
    }
    pub fn framebuffer_depth(&self) -> i32 {
        if self.0.floating_surface {
            16
        } else {
            8
        }
    }
    pub fn pixel_size(&self) -> (i32, i32) {
        (
            self.0.pixel_width.load(Ordering::Acquire),
            self.0.pixel_height.load(Ordering::Acquire),
        )
    }

    pub fn make_current(&self) -> Result<(), String> {
        let context = unsafe { &*(self.0.context as *const NSOpenGLContext) };
        context.makeCurrentContext();
        Ok(())
    }

    pub fn lock_context(&self) -> MutexGuard<'_, ()> {
        self.0
            .gl_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn clear_current(&self) {
        NSOpenGLContext::clearCurrentContext();
    }
    pub fn swap_buffers(&self) {
        let context = unsafe { &*(self.0.context as *const NSOpenGLContext) };
        context.flushBuffer();
    }

    pub unsafe fn get_proc_address(&self, name: *const c_char) -> *mut c_void {
        unsafe { dlsym(RTLD_DEFAULT, name) }
    }
}

fn display_headroom(view: &NSOpenGLView) -> (f64, f64) {
    let Some(screen) = view.window().and_then(|window| window.screen()) else {
        return (1.0, 1.0);
    };
    (
        screen.maximumExtendedDynamicRangeColorComponentValue() as f64,
        screen.maximumPotentialExtendedDynamicRangeColorComponentValue() as f64,
    )
}

impl Drop for SurfaceInner {
    fn drop(&mut self) {
        let view = self.view;
        let container = self.container;
        let context = self.context;
        let _ = self.window.run_on_main_thread(move || unsafe {
            let video_view = &*(view as *const NSOpenGLView);
            let container_view = &*(container as *const NSView);
            container_view.removeFromSuperview();
            video_view.removeFromSuperview();
            video_view.clearGLContext();
            drop(Retained::from_raw(view as *mut NSOpenGLView));
            drop(Retained::from_raw(container as *mut NSView));
            drop(Retained::from_raw(context as *mut NSOpenGLContext));
        });
    }
}
