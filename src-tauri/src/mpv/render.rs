use super::{MpvApi, MpvHandle, MpvRenderContext};
use crate::mpv::surface::NativeSurface;
use std::{
    ffi::{c_char, c_int, c_void, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", target_os = "windows"))]
const MPV_RENDER_UPDATE_FRAME: u64 = 1;

struct RenderWakeup {
    dirty: AtomicBool,
    callbacks: AtomicU64,
}

const MPV_RENDER_PARAM_INVALID: c_int = 0;
const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;
const MPV_RENDER_PARAM_DEPTH: c_int = 5;

#[repr(C)]
pub(crate) struct MpvRenderParam {
    param_type: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct MpvOpenGlInitParams {
    get_proc_address: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
    get_proc_address_ctx: *mut c_void,
    extra_exts: *const c_char,
}

#[repr(C)]
struct MpvOpenGlFbo {
    fbo: c_int,
    width: c_int,
    height: c_int,
    internal_format: c_int,
}

pub(crate) struct Renderer {
    stop: Arc<AtomicBool>,
    presentation: Arc<Mutex<FramePresentation>>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePresentation {
    pub sequence: u64,
    pub width: i32,
    pub height: i32,
}

impl Renderer {
    pub(crate) fn start(
        api: Arc<MpvApi>,
        handle: *mut MpvHandle,
        surface: NativeSurface,
        session_id: &str,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let presentation = Arc::new(Mutex::new(FramePresentation::default()));
        let thread_presentation = Arc::clone(&presentation);
        let handle_address = handle as usize;
        let render_session_id = session_id.to_string();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("vesperwind-mpv-render".to_string())
            .spawn(move || {
                let result = run_renderer(
                    &api,
                    handle_address as *mut MpvHandle,
                    &surface,
                    &thread_stop,
                    &ready_tx,
                    &render_session_id,
                    &thread_presentation,
                );
                if let Err(error) = &result {
                    eprintln!("libmpv renderer stopped: {error}");
                }
                if let Err(error) = result {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                presentation,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                stop.store(true, Ordering::Release);
                let _ = thread.join();
                Err("Timed out while starting libmpv renderer".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = thread.join();
                Err("libmpv renderer failed during startup".to_string())
            }
        }
    }

    pub(crate) fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub(crate) fn presentation(&self) -> FramePresentation {
        self.presentation
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

unsafe extern "C" fn get_proc_address(context: *mut c_void, name: *const c_char) -> *mut c_void {
    if context.is_null() || name.is_null() {
        return ptr::null_mut();
    }
    let surface = unsafe { &*(context as *const NativeSurface) };
    surface.get_proc_address(name)
}

unsafe extern "C" fn request_render(context: *mut c_void) {
    if !context.is_null() {
        let wakeup = unsafe { &*(context as *const RenderWakeup) };
        wakeup.callbacks.fetch_add(1, Ordering::Relaxed);
        wakeup.dirty.store(true, Ordering::Release);
    }
}

fn run_renderer(
    api: &Arc<MpvApi>,
    handle: *mut MpvHandle,
    surface: &NativeSurface,
    stop: &AtomicBool,
    ready: &mpsc::SyncSender<Result<(), String>>,
    session_id: &str,
    presentation: &Mutex<FramePresentation>,
) -> Result<(), String> {
    surface.make_current()?;
    let api_type = CString::new("opengl").unwrap();
    let mut init = MpvOpenGlInitParams {
        get_proc_address: Some(get_proc_address),
        get_proc_address_ctx: (surface as *const NativeSurface).cast_mut().cast(),
        extra_exts: ptr::null(),
    };
    let mut create_params = [
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_API_TYPE,
            data: api_type.as_ptr().cast_mut().cast(),
        },
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
            data: (&mut init as *mut MpvOpenGlInitParams).cast(),
        },
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_INVALID,
            data: ptr::null_mut(),
        },
    ];
    let mut context: *mut MpvRenderContext = ptr::null_mut();
    let status =
        unsafe { (api.render_context_create)(&mut context, handle, create_params.as_mut_ptr()) };
    if status < 0 || context.is_null() {
        return Err(format!("mpv_render_context_create failed with {status}"));
    }

    let wakeup = RenderWakeup {
        dirty: AtomicBool::new(true),
        callbacks: AtomicU64::new(0),
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let diagnostics_enabled = std::env::var_os("VESPERWIND_MPV_RENDER_DIAGNOSTICS").is_some();
    let solid_color = std::env::var_os("VESPERWIND_MPV_DEBUG_SOLID_COLOR").is_some();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let gl_diagnostics = (diagnostics_enabled || solid_color)
        .then(|| GlDiagnostics::load(surface))
        .transpose()?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let mut render_calls = 0_u64;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let mut frame_updates = 0_u64;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let mut logged_non_black = false;
    let mut last_render = Instant::now() - Duration::from_millis(17);
    unsafe {
        (api.render_context_set_update_callback)(
            context,
            Some(request_render),
            (&wakeup as *const RenderWakeup).cast_mut().cast(),
        );
    }
    if solid_color {
        eprintln!("[player={session_id}] render developer solid-color mode enabled");
    }
    let _ = ready.send(Ok(()));

    while !stop.load(Ordering::Acquire) {
        if surface.is_visible()
            && (wakeup.dirty.swap(false, Ordering::AcqRel)
                || surface.take_geometry_changed()
                || last_render.elapsed() >= Duration::from_millis(16))
        {
            let _context_guard = surface.lock_context();
            let (width, height) = surface.pixel_size();
            if width > 0 && height > 0 {
                surface.make_current()?;
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                if solid_color {
                    let diagnostics = gl_diagnostics
                        .as_ref()
                        .ok_or_else(|| "OpenGL diagnostics are unavailable".to_string())?;
                    diagnostics.clear_magenta();
                    surface.swap_buffers();
                    if render_calls == 0 {
                        let samples = diagnostics.sample_front(width, height);
                        eprintln!(
                            "[player={session_id}] render native solid-color presented size={width}x{height} samples={samples:?}"
                        );
                    }
                    render_calls += 1;
                    last_render = Instant::now();
                    thread::sleep(Duration::from_millis(4));
                    continue;
                }
                let mut fbo = MpvOpenGlFbo {
                    fbo: 0,
                    width,
                    height,
                    internal_format: surface.framebuffer_internal_format(),
                };
                let mut flip_y: c_int = 1;
                let mut depth = surface.framebuffer_depth();
                let mut render_params = [
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: (&mut fbo as *mut MpvOpenGlFbo).cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_FLIP_Y,
                        data: (&mut flip_y as *mut c_int).cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_DEPTH,
                        data: (&mut depth as *mut c_int).cast(),
                    },
                    MpvRenderParam {
                        param_type: MPV_RENDER_PARAM_INVALID,
                        data: ptr::null_mut(),
                    },
                ];
                unsafe {
                    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                    (api.render_context_update)(context);
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    if (api.render_context_update)(context) & MPV_RENDER_UPDATE_FRAME != 0 {
                        frame_updates += 1;
                    }
                    let render_status =
                        (api.render_context_render)(context, render_params.as_mut_ptr());
                    if render_status < 0 {
                        return Err(format!(
                            "mpv_render_context_render failed with {render_status}"
                        ));
                    }
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    {
                        render_calls += 1;
                    }
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    if diagnostics_enabled
                        && (render_calls == 1
                            || render_calls == 30
                            || (!logged_non_black && render_calls % 60 == 0))
                    {
                        let samples = gl_diagnostics
                            .as_ref()
                            .expect("diagnostics loaded")
                            .sample_back(width, height);
                        let non_black = samples
                            .iter()
                            .any(|pixel| pixel[0] > 2 || pixel[1] > 2 || pixel[2] > 2);
                        logged_non_black |= non_black;
                        eprintln!(
                            "[player={session_id}] render callbacks={} calls={render_calls} frame_updates={frame_updates} size={width}x{height} back_buffer={samples:?}",
                            wakeup.callbacks.load(Ordering::Relaxed),
                        );
                    }
                }
                surface.swap_buffers();
                unsafe { (api.render_context_report_swap)(context) };
                let mut frame = presentation
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                frame.sequence += 1;
                frame.width = width;
                frame.height = height;
                drop(frame);
                last_render = Instant::now();
            }
        }
        thread::sleep(Duration::from_millis(4));
    }

    unsafe {
        (api.render_context_set_update_callback)(context, None, ptr::null_mut());
        (api.render_context_free)(context);
    }
    surface.clear_current();
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct GlDiagnostics {
    clear_color: unsafe extern "system" fn(f32, f32, f32, f32),
    clear: unsafe extern "system" fn(u32),
    read_buffer: unsafe extern "system" fn(u32),
    read_pixels: unsafe extern "system" fn(i32, i32, i32, i32, u32, u32, *mut c_void),
    finish: unsafe extern "system" fn(),
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl GlDiagnostics {
    fn load(surface: &NativeSurface) -> Result<Self, String> {
        unsafe fn symbol(surface: &NativeSurface, name: &str) -> Result<*mut c_void, String> {
            let name = CString::new(name).map_err(|error| error.to_string())?;
            let pointer = unsafe { surface.get_proc_address(name.as_ptr()) };
            (!pointer.is_null())
                .then_some(pointer)
                .ok_or_else(|| format!("OpenGL symbol {name:?} is unavailable"))
        }
        unsafe {
            Ok(Self {
                clear_color: std::mem::transmute(symbol(surface, "glClearColor")?),
                clear: std::mem::transmute(symbol(surface, "glClear")?),
                read_buffer: std::mem::transmute(symbol(surface, "glReadBuffer")?),
                read_pixels: std::mem::transmute(symbol(surface, "glReadPixels")?),
                finish: std::mem::transmute(symbol(surface, "glFinish")?),
            })
        }
    }

    fn clear_magenta(&self) {
        unsafe {
            (self.clear_color)(1.0, 0.0, 1.0, 1.0);
            (self.clear)(0x0000_4000);
            (self.finish)();
        }
    }

    fn sample_back(&self, width: i32, height: i32) -> [[u8; 4]; 5] {
        self.sample(0x0405, width, height)
    }

    fn sample_front(&self, width: i32, height: i32) -> [[u8; 4]; 5] {
        self.sample(0x0404, width, height)
    }

    fn sample(&self, buffer: u32, width: i32, height: i32) -> [[u8; 4]; 5] {
        let points = [
            (width / 4, height / 4),
            (width / 2, height / 4),
            (width / 2, height / 2),
            (width / 4, height * 3 / 4),
            (width * 3 / 4, height * 3 / 4),
        ];
        let mut samples = [[0_u8; 4]; 5];
        unsafe {
            (self.read_buffer)(buffer);
            for (sample, (x, y)) in samples.iter_mut().zip(points) {
                (self.read_pixels)(
                    x.max(0),
                    y.max(0),
                    1,
                    1,
                    0x1908,
                    0x1401,
                    sample.as_mut_ptr().cast(),
                );
            }
            (self.finish)();
        }
        samples
    }
}
