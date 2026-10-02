//! Application-owned host only. mpv/MoltenVK own device, swapchain and draws.
use super::{DisplayCapabilities, PlayerGeometry};
use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CACornerMask, CAMetalLayer, CATransaction};
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    mpsc, Arc, Mutex, MutexGuard,
};
use std::time::Duration;
use tauri::Window;

struct Inner {
    window: Window,
    root: usize,
    container: usize,
    view: usize,
    layer: usize,
    width: AtomicI32,
    height: AtomicI32,
    visible: AtomicBool,
    retired: AtomicBool,
    changed: AtomicBool,
    display: Mutex<DisplayCapabilities>,
    // Used only by the common surface interface; no GPU operation takes it.
    unused_gl_lock: Mutex<()>,
}
// All addresses are owned retains, dereferenced only on the main thread.
// Closures retain Inner with Arc; mpv is destroyed before the host is released.
// usize addresses already implement Send/Sync; no unsafe trait impl is needed.

#[derive(Clone)]
pub struct MetalSurface(Arc<Inner>);
impl MetalSurface {
    pub fn create(window: &Window) -> Result<Self, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        let host_window = window.clone();
        window
            .run_on_main_thread(move || {
                let result = (|| -> Result<Self, String> {
                    let mtm =
                        MainThreadMarker::new().ok_or("Metal host requires the main thread")?;
                    let root = host_window.ns_view().map_err(|e| e.to_string())?;
                    let root_view = unsafe { Retained::retain(root as *mut NSView) }
                        .ok_or("Metal host root view is unavailable")?;
                    root_view.setWantsLayer(true);
                    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(2.0, 2.0));
                    let container = NSView::initWithFrame(NSView::alloc(mtm), frame);
                    container.setWantsLayer(true);
                    container.setHidden(true);
                    if let Some(layer) = container.layer() {
                        layer.setMaskedCorners(
                            CACornerMask::LayerMinXMinYCorner | CACornerMask::LayerMaxXMinYCorner,
                        );
                    }
                    let view = NSView::initWithFrame(NSView::alloc(mtm), frame);
                    let layer = CAMetalLayer::new();
                    layer.setOpaque(true);
                    layer.setDrawableSize(NSSize::new(2.0, 2.0));
                    // A layer-hosting view: AppKit doesn't replace our Metal layer.
                    // Geometry is always updated explicitly by this host.
                    view.setLayer(Some(&layer));
                    view.setWantsLayer(true);
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
                    Ok(Self(Arc::new(Inner {
                        window: host_window,
                        root: Retained::into_raw(root_view) as usize,
                        container: Retained::into_raw(container) as usize,
                        view: Retained::into_raw(view) as usize,
                        layer: Retained::into_raw(layer) as usize,
                        width: AtomicI32::new(2),
                        height: AtomicI32::new(2),
                        visible: AtomicBool::new(false),
                        retired: AtomicBool::new(false),
                        changed: AtomicBool::new(true),
                        display: Mutex::new(DisplayCapabilities {
                            platform: "macos".into(),
                            surface_format: "mpv-owned Metal (not configured)".into(),
                            ..Default::default()
                        }),
                        unused_gl_lock: Mutex::new(()),
                    })))
                })();
                // If create timed out, SendError drops the fully owned surface
                // here on the main thread, removing its views and all retains.
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        let surface = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())??;
        surface.refresh_display_capabilities();
        Ok(surface)
    }
    pub fn host_address(&self) -> usize {
        self.0.layer
    }
    pub fn set_geometry(&self, geometry: PlayerGeometry) -> Result<(), String> {
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                if inner.retired.load(Ordering::Acquire) { return; }
                let root = unsafe { &*(inner.root as *const NSView) };
                let container = unsafe { &*(inner.container as *const NSView) };
                let view = unsafe { &*(inner.view as *const NSView) };
                let layer = unsafe { &*(inner.layer as *const CAMetalLayer) };
                // Publish host geometry as one non-animated CA transaction.
                // A paused VO cannot rely on the next drawable submission to
                // commit changes made to the shared layer on the main thread.
                CATransaction::begin();
                CATransaction::setDisableActions(true);
                let root_height = root.bounds().size.height;
                let offset = geometry
                    .viewport_height
                    .map(|h| (root_height - h).max(0.0))
                    .unwrap_or(0.0);
                let size = NSSize::new(geometry.width.max(0.0), geometry.height.max(0.0));
                container.setFrame(NSRect::new(
                    NSPoint::new(
                        geometry.x,
                        root_height - geometry.y - offset - geometry.height,
                    ),
                    size,
                ));
                view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), size));
                layer.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), size));
                let scale = view
                    .window()
                    .map(|w| w.backingScaleFactor())
                    .unwrap_or(geometry.scale_factor)
                    .max(1.0);
                layer.setContentsScale(scale);
                // Never resize a hidden/parked swapchain to 0/1. Some MoltenVK
                // present-completion paths use 1x1 internally; keep host geometry.
                let width = (size.width * scale).round().max(2.0) as i32;
                let height = (size.height * scale).round().max(2.0) as i32;
                layer.setDrawableSize(NSSize::new(width as f64, height as f64));
                if let Some(clip) = container.layer() {
                    clip.setCornerRadius(geometry.border_radius.max(0.0));
                    clip.setMasksToBounds(geometry.border_radius > 0.0);
                }
                CATransaction::commit();
                inner.width.store(width, Ordering::Release);
                inner.height.store(height, Ordering::Release);
                inner.changed.store(true, Ordering::Release);
                if std::env::var_os("VESPERWIND_MPV_LOG").is_some() {
                    eprintln!("[metal-host] geometry logical={}x{} scale={scale} drawable={width}x{height} radius={} origin={},{} root={:?} rootFrame={:?} container={:?} containerBounds={:?} clip={:?} layer={:?}", size.width, size.height, geometry.border_radius, geometry.x, geometry.y, root.bounds(), root.frame(), container.frame(), container.bounds(), container.layer().map(|l| l.frame()), layer.frame());
                    eprintln!("[metal-host] rootLayer={:?} rootLayerBounds={:?} viewBounds={:?} layerBounds={:?}", root.layer().map(|l| l.frame()), root.layer().map(|l| l.bounds()), view.bounds(), layer.bounds());
                }
                refresh(&inner);
            })
            .map_err(|e| e.to_string())
    }
    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        let visible = visible && !self.0.retired.load(Ordering::Acquire);
        self.0.visible.store(visible, Ordering::Release);
        let inner = Arc::clone(&self.0);
        let (tx, rx) = mpsc::sync_channel(1);
        self.0
            .window
            .run_on_main_thread(move || {
                let view = unsafe { &*(inner.container as *const NSView) };
                view.setHidden(!visible || inner.retired.load(Ordering::Acquire));
                if visible && std::env::var_os("VESPERWIND_MPV_LOG").is_some() {
                    let root = unsafe { &*(inner.root as *const NSView) };
                    eprintln!(
                        "[metal-host] show rootPresentation={:?} containerPresentation={:?}",
                        root.layer()
                            .and_then(|l| unsafe { l.presentationLayer() })
                            .map(|l| l.frame()),
                        view.layer()
                            .and_then(|l| unsafe { l.presentationLayer() })
                            .map(|l| l.frame())
                    );
                }
                inner.changed.store(true, Ordering::Release);
                let _ = tx.send(());
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    pub fn set_transition_visible(&self, visible: bool) -> Result<(), String> {
        self.set_visible(visible)
    }
    pub fn retire(&self) {
        // Invalidates already-cloned command access as well as queued geometry.
        self.0.retired.store(true, Ordering::Release);
        self.0.visible.store(false, Ordering::Release);
    }
    pub fn is_visible(&self) -> bool {
        self.0.visible.load(Ordering::Acquire)
    }
    pub fn take_geometry_changed(&self) -> bool {
        self.0.changed.swap(false, Ordering::AcqRel)
    }
    pub fn refresh_display_capabilities(&self) {
        let inner = Arc::clone(&self.0);
        let _ = self.0.window.run_on_main_thread(move || refresh(&inner));
    }
    pub fn display_capabilities(&self) -> DisplayCapabilities {
        self.0
            .display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn pixel_size(&self) -> (i32, i32) {
        (
            self.0.width.load(Ordering::Acquire),
            self.0.height.load(Ordering::Acquire),
        )
    }
    pub fn lock_context(&self) -> MutexGuard<'_, ()> {
        self.0
            .unused_gl_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }
}
fn refresh(inner: &Inner) {
    let view = unsafe { &*(inner.view as *const NSView) };
    let layer = unsafe { &*(inner.layer as *const CAMetalLayer) };
    let screen = view.window().and_then(|w| w.screen());
    let current = screen
        .as_ref()
        .map(|s| s.maximumExtendedDynamicRangeColorComponentValue())
        .unwrap_or(1.0);
    let potential = screen
        .as_ref()
        .map(|s| s.maximumPotentialExtendedDynamicRangeColorComponentValue())
        .unwrap_or(1.0);
    let space = layer.colorspace();
    let color_name = space.as_ref().and_then(|s| {
        // CGColorSpace names are concrete state set by MoltenVK, not our request.
        let name = objc2_core_graphics::CGColorSpace::name(Some(s));
        name.map(|n| {
            unsafe { &*std::ptr::from_ref(&*n).cast::<objc2_foundation::NSString>() }.to_string()
        })
    });
    let pixel = layer.pixelFormat().0 as u64;
    let pixel_name = match pixel {
        80 => "BGRA8Unorm",
        81 => "BGRA8Unorm_sRGB",
        90 => "RGB10A2Unorm",
        94 => "BGR10A2Unorm",
        115 => "RGBA16Float",
        _ => "other",
    };
    let device = layer.device().is_some();
    *inner.display.lock().unwrap_or_else(|e| e.into_inner()) = DisplayCapabilities {
        platform: "macos".into(),
        hdr_capable: potential > 1.0,
        hdr_enabled: current > 1.0,
        hdr_state_verified: screen.is_some(),
        hdr_capability_verified: screen.is_some(),
        output_supported: device,
        surface_format: format!("mpv-owned Metal / {pixel_name} ({pixel})"),
        current_headroom: current,
        potential_headroom: potential,
        metal_pixel_format: Some(pixel),
        metal_color_space: color_name,
        metal_edr_enabled: Some(layer.wantsExtendedDynamicRangeContent()),
        metal_edr_metadata_present: Some(layer.EDRMetadata().is_some()),
        reason: (!device).then(|| "Metal swapchain has not initialized".into()),
        ..Default::default()
    };
}
impl Drop for Inner {
    fn drop(&mut self) {
        // PlayerRuntime destroys mpv and joins its VO before the final host Arc
        // drops. Pending main-thread closures keep their own Arc alive.
        let (root, container, view, layer) = (self.root, self.container, self.view, self.layer);
        let _ = self.window.run_on_main_thread(move || unsafe {
            (&*(container as *const NSView)).removeFromSuperview();
            (&*(view as *const NSView)).removeFromSuperview();
            drop(Retained::from_raw(view as *mut NSView));
            drop(Retained::from_raw(container as *mut NSView));
            drop(Retained::from_raw(layer as *mut CAMetalLayer));
            drop(Retained::from_raw(root as *mut NSView));
            if std::env::var_os("VESPERWIND_MPV_LOG").is_some() {
                eprintln!("[metal-host] removed views and released layer");
            }
        });
    }
}
