// A black cover owned by the native window, above the video surface and the
// media overlay WebView. WebViews resize and repaint asynchronously, so a cover
// painted by a WebView shows stale geometry for a frame whenever the window or
// the WebView changes size. Native views change size within the window's own
// composition and stay opaque for the whole fullscreen transition.

use std::{thread, time::Duration};
use tauri::Window;

/// Returns `false` when this platform has no native cover; callers fall back
/// to the WebView cover.
pub fn set_cover(window: &Window, covered: bool, duration: Duration) -> Result<bool, String> {
    platform::set_cover(window, covered, duration)
}

#[cfg(target_os = "macos")]
pub(crate) use platform::cover_view;
#[cfg(target_os = "windows")]
pub(crate) use platform::cover_window;

fn wait_for_main<T: Send + 'static>(
    window: &Window,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = sender.send(task());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{thread, wait_for_main, Duration, Window};
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAnimatablePropertyContainer, NSAnimationContext, NSAutoresizingMaskOptions, NSColor,
        NSView, NSWindowOrderingMode,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    // One cover per process: the media viewer exists only in the main window.
    static COVER: AtomicUsize = AtomicUsize::new(0);
    static COVER_GENERATION: AtomicUsize = AtomicUsize::new(0);

    pub(crate) fn cover_view() -> Option<usize> {
        Some(COVER.load(Ordering::Acquire)).filter(|view| *view != 0)
    }

    fn ensure_cover(root: &NSView, mtm: MainThreadMarker) -> &'static NSView {
        if let Some(view) = cover_view() {
            return unsafe { &*(view as *const NSView) };
        }
        let view = NSView::initWithFrame(NSView::alloc(mtm), root.bounds());
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            layer.setBackgroundColor(Some(&NSColor::blackColor().CGColor()));
        }
        // Follow the window during the fullscreen Space animation without IPC.
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        view.setAlphaValue(0.0);
        view.setHidden(true);
        let pointer = Retained::into_raw(view) as usize;
        COVER.store(pointer, Ordering::Release);
        unsafe { &*(pointer as *const NSView) }
    }

    pub fn set_cover(window: &Window, covered: bool, duration: Duration) -> Result<bool, String> {
        let host_window = window.clone();
        let generation = COVER_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        let seconds = duration.as_secs_f64();
        wait_for_main(window, move || {
            if COVER_GENERATION.load(Ordering::Acquire) != generation {
                return Ok::<_, String>(());
            }
            let Some(mtm) = MainThreadMarker::new() else {
                return Err("Transition cover requires the main thread".into());
            };
            let root = host_window.ns_view().map_err(|error| error.to_string())?;
            let root = unsafe { &*(root as *const NSView) };
            let cover = ensure_cover(root, mtm);
            if covered {
                cover.setFrame(root.bounds());
                let is_topmost = root
                    .subviews()
                    .lastObject()
                    .is_some_and(|last| std::ptr::eq(&*last, cover));
                if !is_topmost {
                    root.addSubview_positioned_relativeTo(cover, NSWindowOrderingMode::Above, None);
                }
                cover.setHidden(false);
            } else {
                // AppKit may retain the pre-fullscreen composite while paused.
                // Request a repaint of the resized subtree; IPC/frame
                // acknowledgements alone do not invalidate that composite.
                root.setNeedsDisplay(true);
                // Never call display()/CATransaction::flush() from a Tauri
                // main-thread task: drawRect re-enters Tao's event handler
                // while its dispatch mutex is held. Let AppKit paint in the
                // next run-loop iteration.
            }
            NSAnimationContext::beginGrouping();
            NSAnimationContext::currentContext().setDuration(seconds);
            cover
                .animator()
                .setAlphaValue(if covered { 1.0 } else { 0.0 });
            NSAnimationContext::endGrouping();
            if std::env::var_os("VESPERWIND_MPV_LOG").is_some() {
                eprintln!(
                    "[transition-cover] generation={generation} covered={covered} root={:?}",
                    root.bounds()
                );
            }
            Ok(())
        })??;
        // Return after the animation, so callers act on a fully opaque cover.
        thread::sleep(duration + Duration::from_millis(20));
        if !covered {
            wait_for_main(window, move || {
                if COVER_GENERATION.load(Ordering::Acquire) != generation {
                    return;
                }
                if let Some(view) = cover_view() {
                    let cover = unsafe { &*(view as *const NSView) };
                    // AppKit's animator may finish late during a Space resize.
                    // Commit the final state, unless a newer cover superseded us.
                    cover.setAlphaValue(0.0);
                    cover.setHidden(true);
                    if std::env::var_os("VESPERWIND_MPV_LOG").is_some() {
                        eprintln!("[transition-cover] generation={generation} hidden");
                    }
                }
            })?;
        }
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{thread, wait_for_main, Duration, Window};
    use std::{
        mem::{size_of, zeroed},
        ptr,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{
            GetMonitorInfoW, GetStockObject, MonitorFromWindow, BLACK_BRUSH, HBRUSH, MONITORINFO,
            MONITOR_DEFAULTTONEAREST,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, RegisterClassW, SetLayeredWindowAttributes,
            SetWindowPos, ShowWindow, HWND_TOP, LWA_ALPHA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
            WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        },
    };

    // One cover per process: the media viewer exists only in the main window.
    static COVER: AtomicUsize = AtomicUsize::new(0);
    const FRAME: Duration = Duration::from_millis(16);
    const CLASS_NAME: &[u16] = &[
        b'V' as u16,
        b'e' as u16,
        b's' as u16,
        b'p' as u16,
        b'e' as u16,
        b'r' as u16,
        b'w' as u16,
        b'i' as u16,
        b'n' as u16,
        b'd' as u16,
        b'C' as u16,
        b'o' as u16,
        b'v' as u16,
        b'e' as u16,
        b'r' as u16,
        0,
    ];

    pub(crate) fn cover_window() -> Option<HWND> {
        Some(COVER.load(Ordering::Acquire))
            .filter(|hwnd| *hwnd != 0)
            .map(|hwnd| hwnd as HWND)
    }

    unsafe extern "system" fn cover_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    unsafe fn ensure_cover(parent: HWND) -> Result<HWND, String> {
        if let Some(hwnd) = cover_window() {
            return Ok(hwnd);
        }
        let instance: HINSTANCE = unsafe { GetModuleHandleW(ptr::null()) };
        let class = WNDCLASSW {
            lpfnWndProc: Some(cover_window_proc),
            hInstance: instance,
            hbrBackground: unsafe { GetStockObject(BLACK_BRUSH) } as HBRUSH,
            lpszClassName: CLASS_NAME.as_ptr(),
            ..unsafe { zeroed() }
        };
        unsafe { RegisterClassW(&class) };
        // Layered child windows need the Windows 8+ manifest entry, which
        // windows-compatibility.manifest declares.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE,
                CLASS_NAME.as_ptr(),
                CLASS_NAME.as_ptr(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent,
                ptr::null_mut(),
                instance,
                ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        unsafe { SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA) };
        COVER.store(hwnd as usize, Ordering::Release);
        Ok(hwnd)
    }

    // The parent's monitor bounds cover its client area both windowed and in
    // fullscreen, so the cover needs no resize when the window changes mode.
    unsafe fn monitor_size(parent: HWND) -> (i32, i32) {
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..unsafe { zeroed() }
        };
        let monitor = unsafe { MonitorFromWindow(parent, MONITOR_DEFAULTTONEAREST) };
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return (16_384, 16_384);
        }
        (
            info.rcMonitor.right - info.rcMonitor.left,
            info.rcMonitor.bottom - info.rcMonitor.top,
        )
    }

    fn set_alpha(window: &Window, alpha: u8) -> Result<(), String> {
        wait_for_main(window, move || {
            if let Some(hwnd) = cover_window() {
                unsafe { SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) };
            }
        })
    }

    pub fn set_cover(window: &Window, covered: bool, duration: Duration) -> Result<bool, String> {
        let parent = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        if covered {
            let shown = wait_for_main(window, move || unsafe {
                let parent = parent as HWND;
                let hwnd = ensure_cover(parent)?;
                let (width, height) = monitor_size(parent);
                SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
                if SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    0,
                    0,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                Ok(())
            })?;
            if let Err(error) = shown {
                eprintln!("[player] native transition cover unavailable: {error}");
                return Ok(false);
            }
        } else if cover_window().is_none() {
            return Ok(true);
        }
        let steps = (duration.as_millis() / FRAME.as_millis()).max(1) as u32;
        for step in 1..=steps {
            let progress = step as f64 / steps as f64;
            let opacity = if covered { progress } else { 1.0 - progress };
            set_alpha(window, (opacity * 255.0).round() as u8)?;
            thread::sleep(FRAME);
        }
        if !covered {
            wait_for_main(window, || {
                if let Some(hwnd) = cover_window() {
                    unsafe { ShowWindow(hwnd, SW_HIDE) };
                }
            })?;
        }
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{Duration, Window};

    pub fn set_cover(_: &Window, _: bool, _: Duration) -> Result<bool, String> {
        Ok(false)
    }
}
