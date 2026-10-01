use super::{DisplayCapabilities, PlayerGeometry};
use std::{
    ffi::{c_char, c_void},
    mem::{size_of, transmute, zeroed},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{Manager, Window};
use windows::{
    core::Interface,
    Win32::{
        Devices::Display::{
            DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
            DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
            DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
            DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SDR_WHITE_LEVEL,
            DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
        },
        Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6},
    },
};
use windows_sys::Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
    Graphics::{
        Gdi::{
            CreateRoundRectRgn, DeleteObject, GetClipBox, GetDC, MonitorFromWindow, ReleaseDC,
            SetWindowRgn, HDC, MONITOR_DEFAULTTONEAREST,
        },
        OpenGL::{
            wglCreateContext, wglDeleteContext, wglGetCurrentContext, wglGetCurrentDC,
            wglGetProcAddress, wglMakeCurrent, ChoosePixelFormat, SetPixelFormat, SwapBuffers,
            HGLRC, PFD_DOUBLEBUFFER, PFD_DRAW_TO_WINDOW, PFD_MAIN_PLANE, PFD_SUPPORT_OPENGL,
            PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR,
        },
    },
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClassNameW, GetClientRect, GetParent,
        GetWindow, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, RegisterClassW,
        SetWindowLongPtrW, SetWindowPos, CS_HREDRAW, CS_OWNDC, CS_VREDRAW, GWL_EXSTYLE, GWL_STYLE,
        GW_CHILD, GW_HWNDNEXT, HWND_TOP, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, SWP_SHOWWINDOW, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    },
};

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
    b'M' as u16,
    b'p' as u16,
    b'v' as u16,
    0,
];
const OPENGL32: &[u16] = &[
    b'o' as u16,
    b'p' as u16,
    b'e' as u16,
    b'n' as u16,
    b'g' as u16,
    b'l' as u16,
    b'3' as u16,
    b'2' as u16,
    b'.' as u16,
    b'd' as u16,
    b'l' as u16,
    b'l' as u16,
    0,
];
const WGL_CONTEXT_MAJOR_VERSION_ARB: i32 = 0x2091;
const WGL_CONTEXT_MINOR_VERSION_ARB: i32 = 0x2092;
const WGL_CONTEXT_PROFILE_MASK_ARB: i32 = 0x9126;
const WGL_CONTEXT_CORE_PROFILE_BIT_ARB: i32 = 0x00000001;
type WglCreateContextAttribs = unsafe extern "system" fn(HDC, HGLRC, *const i32) -> HGLRC;

struct SurfaceInner {
    window: Window,
    hwnd: HWND,
    dc: HDC,
    context: HGLRC,
    pixel_width: AtomicI32,
    pixel_height: AtomicI32,
    visible: AtomicBool,
    geometry_changed: AtomicBool,
    gl_lock: Mutex<()>,
}

unsafe impl Send for SurfaceInner {}
unsafe impl Sync for SurfaceInner {}

#[derive(Clone)]
pub struct NativeSurface(Arc<SurfaceInner>);

unsafe extern "system" fn surface_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

impl NativeSurface {
    pub fn create(window: &Window) -> Result<Self, String> {
        Self::create_with_context(window, true)
    }

    pub fn create_video_host(window: &Window) -> Result<Self, String> {
        Self::create_with_context(window, false)
    }

    pub fn host_address(&self) -> usize {
        self.0.hwnd as usize
    }

    fn create_with_context(window: &Window, opengl: bool) -> Result<Self, String> {
        // Transparent overlay pixels expose the native parent where its
        // border is wider than the video child. Avoid the default white brush.
        window
            .set_background_color(Some(tauri::window::Color(0, 0, 0, 255)))
            .map_err(|error| error.to_string())?;
        let main_webview = window
            .app_handle()
            .get_webview("main")
            .ok_or_else(|| "Main WebView is unavailable".to_string())?;
        let (clip_sender, clip_receiver) = mpsc::sync_channel(1);
        main_webview
            .with_webview(move |platform| {
                let result = (|| {
                    let mut container = windows::Win32::Foundation::HWND::default();
                    unsafe { platform.controller().ParentWindow(&mut container) }
                        .map_err(|error| error.to_string())?;
                    if container.0.is_null() {
                        return Err("Main WebView child is unavailable".to_string());
                    }
                    unsafe {
                        let style = GetWindowLongPtrW(container.0, GWL_STYLE);
                        if SetWindowLongPtrW(
                            container.0,
                            GWL_STYLE,
                            style | WS_CLIPSIBLINGS as isize,
                        ) == 0
                        {
                            return Err(std::io::Error::last_os_error().to_string());
                        }
                    }
                    Ok(())
                })();
                let _ = clip_sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        clip_receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())??;
        // Tauri returns the windows crate's HWND newtype; windows-sys uses
        // its raw pointer. Carry the address across the main-thread closure.
        let parent: HWND = window.hwnd().map_err(|error| error.to_string())?.0;
        let parent = parent as usize;
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = unsafe { create_surface(parent as HWND, opengl) }
                    .map(|(hwnd, dc, context)| (hwnd as usize, dc as usize, context as usize));
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        let (hwnd, dc, context) = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())??;

        Ok(Self(Arc::new(SurfaceInner {
            window: window.clone(),
            hwnd: hwnd as HWND,
            dc: dc as HDC,
            context: context as HGLRC,
            pixel_width: AtomicI32::new(1),
            pixel_height: AtomicI32::new(1),
            visible: AtomicBool::new(false),
            geometry_changed: AtomicBool::new(true),
            gl_lock: Mutex::new(()),
        })))
    }

    pub fn set_geometry(&self, geometry: PlayerGeometry) -> Result<(), String> {
        let scale = geometry.scale_factor.max(1.0);
        let x = (geometry.x * scale).round() as i32;
        let y = (geometry.y * scale).round() as i32;
        let width = (geometry.width.max(0.0) * scale).round() as i32;
        let height = (geometry.height.max(0.0) * scale).round() as i32;
        let radius = geometry.border_radius.max(0.0) * scale;
        let hwnd = self.0.hwnd as usize;
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                // Never wait for the render thread in the window's message
                // pump: a driver can send synchronous window messages while
                // SwapBuffers holds the render lock. HWND layout does not
                // bind or change the worker's OpenGL context.
                unsafe {
                    SetWindowPos(
                        hwnd as HWND,
                        ptr::null_mut(),
                        x,
                        y,
                        width,
                        height,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
                if let Err(error) = set_window_clip(hwnd as HWND, radius) {
                    eprintln!("[WGL] window clipping failed: {error}");
                }
                inner.pixel_width.store(width, Ordering::Release);
                inner.pixel_height.store(height, Ordering::Release);
                inner.geometry_changed.store(true, Ordering::Release);
                if !inner.dc.is_null() && std::env::var_os("VESPERWIND_MPV_RENDER_DIAGNOSTICS").is_some() {
                    let mut clip = Default::default();
                    let clip_type = unsafe { GetClipBox(inner.dc, &mut clip) };
                    eprintln!(
                        "[WGL] geometry={x},{y} {width}x{height} clip_type={clip_type} clip={},{},{},{}",
                        clip.left, clip.top, clip.right, clip.bottom
                    );
                    unsafe { log_window_stack(inner.hwnd) };
                }
            })
            .map_err(|error| error.to_string())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.update_visibility(visible, true)
    }

    pub fn set_transition_visible(&self, visible: bool) -> Result<(), String> {
        self.update_visibility(visible, false)
    }

    fn update_visibility(&self, visible: bool, raise: bool) -> Result<(), String> {
        self.0.visible.store(visible, Ordering::Release);
        self.0.geometry_changed.store(true, Ordering::Release);
        let hwnd = self.0.hwnd as usize;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.0
            .window
            .run_on_main_thread(move || {
                // Initial display raises video above the main WebView. After
                // a fullscreen resize it must stay BELOW the opaque cover.
                let flags = SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOACTIVATE
                    | if visible {
                        SWP_SHOWWINDOW
                    } else {
                        SWP_HIDEWINDOW
                    }
                    | if visible && raise { 0 } else { SWP_NOZORDER };
                let result =
                    if unsafe { SetWindowPos(hwnd as HWND, HWND_TOP, 0, 0, 0, 0, flags) } == 0 {
                        Err(std::io::Error::last_os_error().to_string())
                    } else {
                        Ok(())
                    };
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?
    }

    pub fn is_visible(&self) -> bool {
        self.0.visible.load(Ordering::Acquire)
    }
    pub fn take_geometry_changed(&self) -> bool {
        self.0.geometry_changed.swap(false, Ordering::AcqRel)
    }
    pub fn refresh_display_capabilities(&self) {}
    pub fn display_capabilities(&self) -> DisplayCapabilities {
        let mut display =
            query_display_capabilities(self.0.hwnd).unwrap_or_else(|reason| DisplayCapabilities {
                platform: "windows".to_string(),
                surface_format: "WGL RGBA8".to_string(),
                output_supported: false,
                reason: Some(reason),
                ..DisplayCapabilities::default()
            });
        if self.0.context.is_null() {
            display.surface_format = "mpv-owned D3D11 SDR (RGBA8 / BT.709)".into();
            display.reason = Some("D3D11 prototype is restricted to SDR output".into());
        }
        display
    }
    pub fn framebuffer_internal_format(&self) -> i32 {
        0
    }
    pub fn framebuffer_depth(&self) -> i32 {
        8
    }
    pub fn pixel_size(&self) -> (i32, i32) {
        (
            self.0.pixel_width.load(Ordering::Acquire),
            self.0.pixel_height.load(Ordering::Acquire),
        )
    }

    pub fn make_current(&self) -> Result<(), String> {
        // This context stays owned by the render thread. Rebinding it on every
        // frame needlessly re-enters the driver while the HWND is resizing.
        if unsafe { wglGetCurrentContext() == self.0.context && wglGetCurrentDC() == self.0.dc } {
            return Ok(());
        }
        if unsafe { wglMakeCurrent(self.0.dc, self.0.context) } == 0 {
            return Err(format!(
                "Unable to activate the Win32 OpenGL context: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn lock_context(&self) -> MutexGuard<'_, ()> {
        self.0
            .gl_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn clear_current(&self) {
        unsafe {
            wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
        }
    }
    pub fn swap_buffers(&self) {
        unsafe {
            if SwapBuffers(self.0.dc) == 0 {
                eprintln!(
                    "[WGL] SwapBuffers failed: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
    }

    pub unsafe fn get_proc_address(&self, name: *const c_char) -> *mut c_void {
        if let Some(proc_address) = unsafe { wglGetProcAddress(name.cast()) } {
            let address = proc_address as *const () as isize;
            if ![-1, 0, 1, 2, 3].contains(&address) {
                return address as *mut c_void;
            }
        }
        // opengl32 is already linked by the WGL calls. Do not increment its
        // module reference count once per resolved OpenGL function.
        let module = unsafe { GetModuleHandleW(OPENGL32.as_ptr()) };
        if module.is_null() {
            return ptr::null_mut();
        }
        unsafe { GetProcAddress(module, name.cast()) }
            .map(|address| address as *const () as *mut c_void)
            .unwrap_or(ptr::null_mut())
    }
}

pub(crate) fn set_window_clip(hwnd: HWND, radius: f64) -> Result<(), String> {
    let mut rect = Default::default();
    if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let diameter = (radius * 2.0).round().max(0.0) as i32;
    let region = if diameter > 0 {
        let region = unsafe {
            CreateRoundRectRgn(0, 0, rect.right + 1, rect.bottom + 1, diameter, diameter)
        };
        if region.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        region
    } else {
        ptr::null_mut()
    };
    // Windows owns the region after a successful SetWindowRgn. A null region
    // restores the full rectangle when entering fullscreen.
    if unsafe { SetWindowRgn(hwnd, region, 1) } == 0 {
        if !region.is_null() {
            unsafe { DeleteObject(region) };
        }
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

unsafe fn log_window_stack(hwnd: HWND) {
    let parent = unsafe { GetParent(hwnd) };
    let mut child = unsafe { GetWindow(parent, GW_CHILD) };
    let mut order = Vec::new();
    for _ in 0..8 {
        if child.is_null() {
            break;
        }
        let mut name = [0_u16; 80];
        let length = unsafe { GetClassNameW(child, name.as_mut_ptr(), name.len() as i32) };
        let mut rect = Default::default();
        unsafe { GetWindowRect(child, &mut rect) };
        order.push(format!(
            "{} hwnd={:p} visible={} style={:x} ex={:x} rect={},{},{},{}",
            String::from_utf16_lossy(&name[..length.max(0) as usize]),
            child,
            unsafe { IsWindowVisible(child) },
            unsafe { GetWindowLongPtrW(child, GWL_STYLE) },
            unsafe { GetWindowLongPtrW(child, GWL_EXSTYLE) },
            rect.left,
            rect.top,
            rect.right,
            rect.bottom
        ));
        child = unsafe { GetWindow(child, GW_HWNDNEXT) };
    }
    eprintln!("[WGL] parent={parent:p} sibling order top first: {order:?}");
}

fn query_display_capabilities(hwnd: HWND) -> Result<DisplayCapabilities, String> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return Err("Unable to resolve the monitor containing the video surface".to_string());
    }
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|error| error.to_string())?;
    let mut adapter_index = 0;
    loop {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(adapter_index) }) else {
            break;
        };
        let mut output_index = 0;
        loop {
            let Ok(output) = (unsafe { adapter.EnumOutputs(output_index) }) else {
                break;
            };
            if let Ok(output6) = output.cast::<IDXGIOutput6>() {
                if let Ok(description) = unsafe { output6.GetDesc1() } {
                    if description.Monitor.0 == monitor.cast() {
                        let device_name = trim_wide(&description.DeviceName);
                        let (capable, enabled, sdr_white_nits) =
                            display_config_color_state(&device_name).unwrap_or((
                                description.ColorSpace.0 == 12,
                                description.ColorSpace.0 == 12,
                                None,
                            ));
                        return Ok(DisplayCapabilities {
                            platform: "windows".to_string(),
                            hdr_capable: capable,
                            hdr_enabled: enabled,
                            output_supported: false,
                            surface_format: "WGL RGBA8".to_string(),
                            max_luminance_nits: positive(description.MaxLuminance),
                            max_full_frame_luminance_nits: positive(
                                description.MaxFullFrameLuminance,
                            ),
                            sdr_white_nits,
                            bits_per_color: Some(description.BitsPerColor),
                            reason: Some(
                                "The public libmpv 0.41 Render API renders to OpenGL; the current WGL RGBA8 surface cannot present an FP16 scRGB or HDR10 DXGI swapchain"
                                    .to_string(),
                            ),
                            ..DisplayCapabilities::default()
                        });
                    }
                }
            }
            output_index += 1;
        }
        adapter_index += 1;
    }
    Err("Unable to match the video surface to an IDXGIOutput6 display".to_string())
}

fn display_config_color_state(device_name: &str) -> Option<(bool, bool, Option<f64>)> {
    let mut path_count = 0;
    let mut mode_count = 0;
    if unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
    }
    .0 != 0
    {
        return None;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![Default::default(); mode_count as usize];
    if unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    }
    .0 != 0
    {
        return None;
    }
    for path in paths.into_iter().take(path_count as usize) {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
        source.header.adapterId = path.sourceInfo.adapterId;
        source.header.id = path.sourceInfo.id;
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0
            || trim_wide(&source.viewGdiDeviceName) != device_name
        {
            continue;
        }

        let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
        color.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
        color.header.size = size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32;
        color.header.adapterId = path.targetInfo.adapterId;
        color.header.id = path.targetInfo.id;
        if unsafe { DisplayConfigGetDeviceInfo(&mut color.header) } != 0 {
            return None;
        }
        let flags = unsafe { color.Anonymous.value };
        let capable = flags & 1 != 0;
        let enabled = flags & 2 != 0;

        let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
        white.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL;
        white.header.size = size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32;
        white.header.adapterId = path.targetInfo.adapterId;
        white.header.id = path.targetInfo.id;
        let sdr_white_nits = (unsafe { DisplayConfigGetDeviceInfo(&mut white.header) } == 0)
            .then_some(white.SDRWhiteLevel as f64 / 1000.0 * 80.0);
        return Some((capable, enabled, sdr_white_nits));
    }
    None
}

fn trim_wide(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

fn positive(value: f32) -> Option<f64> {
    (value > 0.0).then_some(value as f64)
}

unsafe fn create_surface(parent: HWND, opengl: bool) -> Result<(HWND, HDC, HGLRC), String> {
    let instance: HINSTANCE = unsafe { GetModuleHandleW(ptr::null()) };
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
        lpfnWndProc: Some(surface_window_proc),
        hInstance: instance,
        lpszClassName: CLASS_NAME.as_ptr(),
        ..unsafe { zeroed() }
    };
    unsafe { RegisterClassW(&class) };
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            CLASS_NAME.as_ptr(),
            CLASS_NAME.as_ptr(),
            // The transparent controls overlap this entire child. Clipping
            // siblings would exclude their rectangle from the WGL drawable.
            WS_CHILD | WS_CLIPCHILDREN,
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
        return Err("Unable to create the Win32 video child window".to_string());
    }
    if !opengl {
        // The embedded VO owns its child HWND, device and swapchain. This host
        // has no pixel format or WGL context and only controls layout/clipping.
        return Ok((hwnd, ptr::null_mut(), ptr::null_mut()));
    }
    let dc = unsafe { GetDC(hwnd) };
    if dc.is_null() {
        unsafe {
            DestroyWindow(hwnd);
        }
        return Err("Unable to acquire the Win32 video device context".to_string());
    }
    let descriptor = PIXELFORMATDESCRIPTOR {
        nSize: size_of::<PIXELFORMATDESCRIPTOR>() as u16,
        nVersion: 1,
        dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
        iPixelType: PFD_TYPE_RGBA,
        cColorBits: 32,
        cAlphaBits: 8,
        cDepthBits: 24,
        cStencilBits: 8,
        iLayerType: PFD_MAIN_PLANE as u8,
        ..unsafe { zeroed() }
    };
    let format = unsafe { ChoosePixelFormat(dc, &descriptor) };
    if format == 0 || unsafe { SetPixelFormat(dc, format, &descriptor) } == 0 {
        unsafe {
            ReleaseDC(hwnd, dc);
            DestroyWindow(hwnd);
        }
        return Err("Unable to configure the Win32 OpenGL pixel format".to_string());
    }
    let legacy_context = unsafe { wglCreateContext(dc) };
    if legacy_context.is_null() {
        unsafe {
            ReleaseDC(hwnd, dc);
            DestroyWindow(hwnd);
        }
        return Err("Unable to create the Win32 OpenGL context".to_string());
    }
    let context = unsafe {
        if wglMakeCurrent(dc, legacy_context) == 0 {
            wglDeleteContext(legacy_context);
            ReleaseDC(hwnd, dc);
            DestroyWindow(hwnd);
            return Err("Unable to activate the bootstrap Win32 OpenGL context".to_string());
        }
        let modern = wglGetProcAddress(c"wglCreateContextAttribsARB".as_ptr().cast())
            .filter(|address| ![-1, 0, 1, 2, 3].contains(&(*address as *const () as isize)))
            .map(|address| {
                let create: WglCreateContextAttribs = transmute(address);
                let attributes = [
                    WGL_CONTEXT_MAJOR_VERSION_ARB,
                    3,
                    WGL_CONTEXT_MINOR_VERSION_ARB,
                    3,
                    WGL_CONTEXT_PROFILE_MASK_ARB,
                    WGL_CONTEXT_CORE_PROFILE_BIT_ARB,
                    0,
                ];
                create(dc, ptr::null_mut(), attributes.as_ptr())
            })
            .filter(|context| !context.is_null())
            .unwrap_or(legacy_context);
        wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
        if modern != legacy_context {
            wglDeleteContext(legacy_context);
        }
        modern
    };
    Ok((hwnd, dc, context))
}

impl Drop for SurfaceInner {
    fn drop(&mut self) {
        let hwnd = self.hwnd as usize;
        let dc = self.dc as usize;
        let context = self.context as usize;
        let _ = self.window.run_on_main_thread(move || unsafe {
            if context != 0 {
                wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
                wglDeleteContext(context as HGLRC);
            }
            if dc != 0 {
                ReleaseDC(hwnd as HWND, dc as HDC);
            }
            DestroyWindow(hwnd as HWND);
        });
    }
}
