use crate::{provider_content::ContentSource, ssh::SshManager};
use std::{
    collections::HashMap,
    ffi::{c_char, c_void, CStr},
    io::{Read, Seek, SeekFrom},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

const MPV_ERROR_GENERIC: i64 = -20;
const MPV_ERROR_LOADING_FAILED: i32 = -13;

pub type MpvStreamReadFn = unsafe extern "C" fn(*mut c_void, *mut c_char, u64) -> i64;
pub type MpvStreamSeekFn = unsafe extern "C" fn(*mut c_void, i64) -> i64;
pub type MpvStreamSizeFn = unsafe extern "C" fn(*mut c_void) -> i64;
pub type MpvStreamCloseFn = unsafe extern "C" fn(*mut c_void);
pub type MpvStreamCancelFn = unsafe extern "C" fn(*mut c_void);
pub type MpvStreamOpenFn =
    unsafe extern "C" fn(*mut c_void, *mut c_char, *mut MpvStreamCbInfo) -> i32;

#[repr(C)]
pub struct MpvStreamCbInfo {
    pub cookie: *mut c_void,
    pub read_fn: Option<MpvStreamReadFn>,
    pub seek_fn: Option<MpvStreamSeekFn>,
    pub size_fn: Option<MpvStreamSizeFn>,
    pub close_fn: Option<MpvStreamCloseFn>,
    pub cancel_fn: Option<MpvStreamCancelFn>,
}

pub struct MpvStreamRegistry {
    sources: Mutex<HashMap<String, ContentSource>>,
    ssh: Arc<SshManager>,
}

impl MpvStreamRegistry {
    pub fn new(ssh: Arc<SshManager>) -> Arc<Self> {
        Arc::new(Self {
            sources: Mutex::new(HashMap::new()),
            ssh,
        })
    }

    pub fn register(&self, source: ContentSource) -> String {
        let id = Uuid::new_v4().to_string();
        self.sources
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .insert(id.clone(), source);
        format!("vesperwind://{id}")
    }

    pub fn remove(&self, source_uri: &str) {
        if let Some(id) = source_uri.strip_prefix("vesperwind://") {
            self.sources
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .remove(id);
        }
    }
}

struct StreamCookie {
    stream: Mutex<crate::provider_content::ContentStream>,
    size: u64,
    cancelled: AtomicBool,
}

pub unsafe extern "C" fn open_stream(
    user_data: *mut c_void,
    uri: *mut c_char,
    info: *mut MpvStreamCbInfo,
) -> i32 {
    std::panic::catch_unwind(|| {
        if user_data.is_null() || uri.is_null() || info.is_null() {
            return MPV_ERROR_LOADING_FAILED;
        }
        let registry = unsafe { &*(user_data as *const MpvStreamRegistry) };
        let uri = match unsafe { CStr::from_ptr(uri) }.to_str() {
            Ok(value) => value,
            Err(_) => return MPV_ERROR_LOADING_FAILED,
        };
        let Some(id) = uri.strip_prefix("vesperwind://") else {
            return MPV_ERROR_LOADING_FAILED;
        };
        let source = registry
            .sources
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .get(id)
            .cloned();
        let Some(source) = source else {
            return MPV_ERROR_LOADING_FAILED;
        };
        let Ok(stream) = source.open_stream(&registry.ssh) else {
            return MPV_ERROR_LOADING_FAILED;
        };
        let cookie = Box::new(StreamCookie {
            stream: Mutex::new(stream),
            size: source.metadata().size,
            cancelled: AtomicBool::new(false),
        });
        unsafe {
            ptr::write(
                info,
                MpvStreamCbInfo {
                    cookie: Box::into_raw(cookie).cast(),
                    read_fn: Some(read_stream),
                    seek_fn: Some(seek_stream),
                    size_fn: Some(size_stream),
                    close_fn: Some(close_stream),
                    cancel_fn: Some(cancel_stream),
                },
            );
        }
        0
    })
    .unwrap_or(MPV_ERROR_LOADING_FAILED)
}

unsafe extern "C" fn read_stream(cookie: *mut c_void, buffer: *mut c_char, byte_count: u64) -> i64 {
    std::panic::catch_unwind(|| {
        if cookie.is_null() || buffer.is_null() {
            return -1;
        }
        let cookie = unsafe { &*(cookie as *const StreamCookie) };
        if cookie.cancelled.load(Ordering::Acquire) {
            return -1;
        }
        let Ok(length) = usize::try_from(byte_count) else {
            return -1;
        };
        let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length) };
        cookie
            .stream
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .read(bytes)
            .map(|count| count as i64)
            .unwrap_or(-1)
    })
    .unwrap_or(-1)
}

unsafe extern "C" fn seek_stream(cookie: *mut c_void, offset: i64) -> i64 {
    std::panic::catch_unwind(|| {
        if cookie.is_null() || offset < 0 {
            return MPV_ERROR_GENERIC;
        }
        let cookie = unsafe { &*(cookie as *const StreamCookie) };
        if cookie.cancelled.load(Ordering::Acquire) {
            return MPV_ERROR_GENERIC;
        }
        cookie
            .stream
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .seek(SeekFrom::Start(offset as u64))
            .ok()
            .and_then(|position| i64::try_from(position).ok())
            .unwrap_or(MPV_ERROR_GENERIC)
    })
    .unwrap_or(MPV_ERROR_GENERIC)
}

unsafe extern "C" fn size_stream(cookie: *mut c_void) -> i64 {
    if cookie.is_null() {
        return MPV_ERROR_GENERIC;
    }
    let cookie = unsafe { &*(cookie as *const StreamCookie) };
    i64::try_from(cookie.size).unwrap_or(MPV_ERROR_GENERIC)
}

unsafe extern "C" fn cancel_stream(cookie: *mut c_void) {
    if !cookie.is_null() {
        let cookie = unsafe { &*(cookie as *const StreamCookie) };
        cookie.cancelled.store(true, Ordering::Release);
    }
}

unsafe extern "C" fn close_stream(cookie: *mut c_void) {
    if !cookie.is_null() {
        drop(unsafe { Box::from_raw(cookie as *mut StreamCookie) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{filesystem::Filesystem, provider_content::ContentSource};
    use std::{
        ffi::CString,
        fs::{self, File},
        io::{Seek, SeekFrom, Write},
        sync::atomic::{AtomicU64, Ordering},
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn custom_stream_reads_seeks_sizes_and_cancels_above_four_gb() {
        let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("vesperwind-mpv-stream-{}-{id}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.mkv");
        let size = 5 * 1024 * 1024 * 1024 + 17;
        let mut file = File::create(&path).unwrap();
        file.set_len(size).unwrap();
        file.seek(SeekFrom::Start(size - 4)).unwrap();
        file.write_all(b"tail").unwrap();

        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let ssh = SshManager::new();
        let source =
            ContentSource::open(&filesystem, &ssh, Some("local"), &path.to_string_lossy()).unwrap();
        let registry = MpvStreamRegistry::new(ssh);
        let uri = registry.register(source);
        let uri = CString::new(uri).unwrap();
        let mut info = MpvStreamCbInfo {
            cookie: ptr::null_mut(),
            read_fn: None,
            seek_fn: None,
            size_fn: None,
            close_fn: None,
            cancel_fn: None,
        };

        assert_eq!(
            unsafe {
                open_stream(
                    Arc::as_ptr(&registry).cast_mut().cast(),
                    uri.as_ptr().cast_mut(),
                    &mut info,
                )
            },
            0
        );
        assert_eq!(unsafe { info.size_fn.unwrap()(info.cookie) }, size as i64);
        assert_eq!(
            unsafe { info.seek_fn.unwrap()(info.cookie, (size - 4) as i64) },
            (size - 4) as i64
        );
        let mut bytes = [0_u8; 4];
        assert_eq!(
            unsafe {
                info.read_fn.unwrap()(info.cookie, bytes.as_mut_ptr().cast(), bytes.len() as u64)
            },
            4
        );
        assert_eq!(&bytes, b"tail");
        unsafe { info.cancel_fn.unwrap()(info.cookie) };
        assert_eq!(
            unsafe {
                info.read_fn.unwrap()(info.cookie, bytes.as_mut_ptr().cast(), bytes.len() as u64)
            },
            -1
        );
        unsafe { info.close_fn.unwrap()(info.cookie) };

        fs::remove_dir_all(root).unwrap();
    }
}
