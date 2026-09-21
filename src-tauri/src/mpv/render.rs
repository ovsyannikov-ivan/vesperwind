use super::{MpvApi, MpvHandle, MpvRenderContext};
use crate::mpv::surface::NativeSurface;
use std::{
    ffi::{c_char, c_int, c_void, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

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
    thread: Option<JoinHandle<()>>,
}

impl Renderer {
    pub(crate) fn start(
        api: Arc<MpvApi>,
        handle: *mut MpvHandle,
        surface: NativeSurface,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle_address = handle as usize;
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
        unsafe { &*(context as *const AtomicBool) }.store(true, Ordering::Release);
    }
}

fn run_renderer(
    api: &Arc<MpvApi>,
    handle: *mut MpvHandle,
    surface: &NativeSurface,
    stop: &AtomicBool,
    ready: &mpsc::SyncSender<Result<(), String>>,
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

    let redraw = AtomicBool::new(true);
    let mut last_render = Instant::now() - Duration::from_millis(17);
    unsafe {
        (api.render_context_set_update_callback)(
            context,
            Some(request_render),
            (&redraw as *const AtomicBool).cast_mut().cast(),
        );
    }
    let _ = ready.send(Ok(()));

    while !stop.load(Ordering::Acquire) {
        if surface.is_visible()
            && (redraw.swap(false, Ordering::AcqRel)
                || surface.take_geometry_changed()
                || last_render.elapsed() >= Duration::from_millis(16))
        {
            let _context_guard = surface.lock_context();
            let (width, height) = surface.pixel_size();
            if width > 0 && height > 0 {
                surface.make_current()?;
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
                    (api.render_context_update)(context);
                    let render_status =
                        (api.render_context_render)(context, render_params.as_mut_ptr());
                    if render_status < 0 {
                        return Err(format!(
                            "mpv_render_context_render failed with {render_status}"
                        ));
                    }
                }
                surface.swap_buffers();
                unsafe { (api.render_context_report_swap)(context) };
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
