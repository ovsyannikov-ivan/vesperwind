use std::{ffi::c_void, path::Path};

pub struct DynamicLibrary {
    handle: *mut c_void,
}

unsafe impl Send for DynamicLibrary {}
unsafe impl Sync for DynamicLibrary {}

impl DynamicLibrary {
    pub unsafe fn open(path: &Path) -> Result<Self, String> {
        platform::open(path).map(|handle| Self { handle })
    }

    pub unsafe fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
        let pointer = unsafe { platform::symbol(self.handle, name) }?;
        Ok(unsafe { std::mem::transmute_copy(&pointer) })
    }
}

impl Drop for DynamicLibrary {
    fn drop(&mut self) {
        unsafe { platform::close(self.handle) };
    }
}

#[cfg(unix)]
mod platform {
    use std::{
        ffi::{c_char, c_int, c_void, CStr, CString},
        os::unix::ffi::OsStrExt,
        path::Path,
    };

    const RTLD_NOW: c_int = 2;
    const RTLD_LOCAL: c_int = 4;

    unsafe extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
        fn dlclose(handle: *mut c_void) -> c_int;
        fn dlerror() -> *const c_char;
    }

    pub unsafe fn open(path: &Path) -> Result<*mut c_void, String> {
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
        let handle = unsafe { dlopen(path.as_ptr(), RTLD_NOW | RTLD_LOCAL) };
        if handle.is_null() {
            Err(last_error())
        } else {
            Ok(handle)
        }
    }

    pub unsafe fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let name = CString::new(name).map_err(|error| error.to_string())?;
        let pointer = unsafe { dlsym(handle, name.as_ptr()) };
        if pointer.is_null() {
            Err(last_error())
        } else {
            Ok(pointer)
        }
    }

    pub unsafe fn close(handle: *mut c_void) {
        if !handle.is_null() {
            unsafe { dlclose(handle) };
        }
    }

    fn last_error() -> String {
        let error = unsafe { dlerror() };
        if error.is_null() {
            "Dynamic library operation failed".to_string()
        } else {
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        ffi::{c_char, c_void, CString},
        os::windows::ffi::OsStrExt,
        path::Path,
    };

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    pub unsafe fn open(path: &Path) -> Result<*mut c_void, String> {
        // DLL_LOAD_DIR requires an absolute filename. Resolve even a relative
        // development override, then exclude PATH/current-directory DLL lookup.
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        let path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x00000100;
        const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x00000800;
        let handle = unsafe {
            LoadLibraryExW(
                path.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if handle.is_null() {
            Err(last_error())
        } else {
            Ok(handle)
        }
    }

    pub unsafe fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let name = CString::new(name).map_err(|error| error.to_string())?;
        let pointer = unsafe { GetProcAddress(handle, name.as_ptr()) };
        if pointer.is_null() {
            Err(last_error())
        } else {
            Ok(pointer)
        }
    }

    pub unsafe fn close(handle: *mut c_void) {
        if !handle.is_null() {
            unsafe { FreeLibrary(handle) };
        }
    }

    fn last_error() -> String {
        format!("Windows dynamic library error {}", unsafe {
            GetLastError()
        })
    }
}
