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
use tauri::WebviewWindow;
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
        Gdi::{GetDC, MonitorFromWindow, ReleaseDC, HDC, MONITOR_DEFAULTTONEAREST},
        OpenGL::{
            wglCreateContext, wglDeleteContext, wglGetProcAddress, wglMakeCurrent,
            ChoosePixelFormat, SetPixelFormat, SwapBuffers, HGLRC, PFD_DOUBLEBUFFER,
            PFD_DRAW_TO_WINDOW, PFD_MAIN_PLANE, PFD_SUPPORT_OPENGL, PFD_TYPE_RGBA,
            PIXELFORMATDESCRIPTOR,
        },
    },
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos, ShowWindow,
        CS_HREDRAW, CS_OWNDC, CS_VREDRAW, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOW,
        WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
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
    window: WebviewWindow,
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
    pub fn create(window: &WebviewWindow) -> Result<Self, String> {
        let parent = window.hwnd().map_err(|error| error.to_string())? as usize;
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = unsafe { create_surface(parent as HWND) }
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
        let hwnd = self.0.hwnd as usize;
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                let _gl_guard = inner
                    .gl_lock
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
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
                inner.pixel_width.store(width, Ordering::Release);
                inner.pixel_height.store(height, Ordering::Release);
                inner.geometry_changed.store(true, Ordering::Release);
            })
            .map_err(|error| error.to_string())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.0.visible.store(visible, Ordering::Release);
        self.0.geometry_changed.store(true, Ordering::Release);
        let hwnd = self.0.hwnd as usize;
        let inner = Arc::clone(&self.0);
        self.0
            .window
            .run_on_main_thread(move || {
                let _gl_guard = inner
                    .gl_lock
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                unsafe {
                    ShowWindow(hwnd as HWND, if visible { SW_SHOW } else { SW_HIDE });
                }
            })
            .map_err(|error| error.to_string())
    }

    pub fn is_visible(&self) -> bool {
        self.0.visible.load(Ordering::Acquire)
    }
    pub fn take_geometry_changed(&self) -> bool {
        self.0.geometry_changed.swap(false, Ordering::AcqRel)
    }
    pub fn refresh_display_capabilities(&self) {}
    pub fn display_capabilities(&self) -> DisplayCapabilities {
        query_display_capabilities(self.0.hwnd).unwrap_or_else(|reason| DisplayCapabilities {
            platform: "windows".to_string(),
            surface_format: "WGL RGBA8".to_string(),
            output_supported: false,
            reason: Some(reason),
            ..DisplayCapabilities::default()
        })
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
        if unsafe { wglMakeCurrent(self.0.dc, self.0.context) } == 0 {
            return Err("Unable to activate the Win32 OpenGL context".to_string());
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
            SwapBuffers(self.0.dc);
        }
    }

    pub unsafe fn get_proc_address(&self, name: *const c_char) -> *mut c_void {
        if let Some(proc_address) = unsafe { wglGetProcAddress(name.cast()) } {
            let address = proc_address as *const () as isize;
            if ![-1, 0, 1, 2, 3].contains(&address) {
                return address as *mut c_void;
            }
        }
        let module = unsafe { LoadLibraryW(OPENGL32.as_ptr()) };
        if module.is_null() {
            return ptr::null_mut();
        }
        unsafe { GetProcAddress(module, name.cast()) }
            .map(|address| address as *const () as *mut c_void)
            .unwrap_or(ptr::null_mut())
    }
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

unsafe fn create_surface(parent: HWND) -> Result<(HWND, HDC, HGLRC), String> {
    let instance = unsafe { GetModuleHandleW(ptr::null()) } as HINSTANCE;
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
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
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
            wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
            wglDeleteContext(context as HGLRC);
            ReleaseDC(hwnd as HWND, dc as HDC);
            DestroyWindow(hwnd as HWND);
        });
    }
}
