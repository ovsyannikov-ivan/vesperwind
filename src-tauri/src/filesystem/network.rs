use crate::error::NativeError;

/// System connection only: returned paths always belong to LocalProvider.
pub fn connect_if_network(path: &str, owner: isize) -> Result<String, NativeError> {
    if path.to_ascii_lowercase().starts_with("smb://") {
        let url =
            url::Url::parse(path).map_err(|_| NativeError::new("EINVAL", "Invalid SMB address"))?;
        if url.host_str().is_none()
            || url.path().trim_matches('/').is_empty()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(NativeError::new(
                "EINVAL",
                "Use smb://server/share without credentials; authentication uses the system dialog",
            ));
        }
        #[cfg(target_os = "macos")]
        {
            return mount_macos(path);
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err(NativeError::new(
                "ENOTSUPPORTED",
                "Use a system-mounted path or Windows UNC address on this platform",
            ));
        }
    }
    #[cfg(windows)]
    {
        if path.starts_with("\\\\") && !path.starts_with("\\\\?\\") {
            let parts: Vec<_> = path[2..].split('\\').collect();
            if parts.len() < 2
                || parts[0].is_empty()
                || parts[1].is_empty()
                || parts
                    .iter()
                    .any(|s| *s == ".." || s.contains(['/', ':', '\0']))
            {
                return Err(NativeError::new(
                    "EINVAL",
                    "Use \\\\server\\share or a path within that share",
                ));
            }
            connect_windows(&format!("\\\\{}\\{}", parts[0], parts[1]), owner)?;
        }
    }
    let _ = owner;
    Ok(path.to_string())
}
#[cfg(windows)]
fn connect_windows(share: &str, owner: isize) -> Result<(), NativeError> {
    use windows_sys::Win32::NetworkManagement::WNet::{
        WNetUseConnectionW, CONNECT_INTERACTIVE, NETRESOURCEW, RESOURCETYPE_DISK,
    };
    let mut name: Vec<u16> = share.encode_utf16().chain(Some(0)).collect();
    let resource = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        lpRemoteName: name.as_mut_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    let status = unsafe {
        WNetUseConnectionW(
            owner as _,
            &resource,
            std::ptr::null(),
            std::ptr::null(),
            CONNECT_INTERACTIVE,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(NativeError::new(
            if status == 1223 {
                "ECANCELLED"
            } else {
                "ENETWORK_CONNECT"
            },
            if status == 1223 {
                "Network connection cancelled"
            } else {
                "Unable to connect the network share"
            },
        )
        .with_native_error(format!(
            "WNet error {status}: {}",
            std::io::Error::from_raw_os_error(status as i32)
        )))
    }
}
#[cfg(target_os = "macos")]
fn mount_macos(address: &str) -> Result<String, NativeError> {
    use std::{
        ffi::{c_void, CString},
        ptr,
    };
    type CF = *const c_void;
    const UTF8: u32 = 0x08000100;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: CF, value: *const i8, encoding: u32) -> CF;
        fn CFURLCreateWithString(allocator: CF, value: CF, base: CF) -> CF;
        fn CFDictionaryCreate(
            allocator: CF,
            keys: *const CF,
            values: *const CF,
            count: isize,
            key_callbacks: CF,
            value_callbacks: CF,
        ) -> CF;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFArrayGetCount(array: CF) -> isize;
        fn CFArrayGetValueAtIndex(array: CF, index: isize) -> CF;
        fn CFStringGetCString(value: CF, buffer: *mut i8, size: isize, encoding: u32) -> bool;
        fn CFRelease(value: CF);
    }
    #[link(name = "NetFS", kind = "framework")]
    extern "C" {
        fn NetFSMountURLSync(
            url: CF,
            mount: CF,
            user: CF,
            password: CF,
            open_options: CF,
            mount_options: CF,
            mountpoints: *mut CF,
        ) -> i32;
    }
    struct Owned(CF);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CFRelease(self.0);
                }
            }
        }
    }
    unsafe fn string(value: &str) -> Result<Owned, NativeError> {
        let value = CString::new(value)
            .map_err(|_| NativeError::new("EINVAL", "Invalid network address"))?;
        let result = CFStringCreateWithCString(ptr::null(), value.as_ptr(), UTF8);
        if result.is_null() {
            Err(NativeError::new(
                "ENOMEM",
                "Unable to allocate network address",
            ))
        } else {
            Ok(Owned(result))
        }
    }
    unsafe {
        let address = string(address)?;
        let url = Owned(CFURLCreateWithString(ptr::null(), address.0, ptr::null()));
        if url.0.is_null() {
            return Err(NativeError::new("EINVAL", "Invalid network address"));
        }
        let key = string("UIOption")?;
        let value = string("AllowUI")?;
        let options = Owned(CFDictionaryCreate(
            ptr::null(),
            &key.0,
            &value.0,
            1,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        ));
        let mut points = ptr::null();
        let status = NetFSMountURLSync(
            url.0,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            options.0,
            ptr::null(),
            &mut points,
        );
        let points = Owned(points);
        if status != 0 {
            return Err(NativeError::new(
                if status == -128 {
                    "ECANCELLED"
                } else {
                    "ENETWORK_CONNECT"
                },
                if status == -128 {
                    "Network connection cancelled"
                } else {
                    "Unable to mount the network share"
                },
            )
            .with_native_error(format!("NetFS status {status}")));
        }
        if points.0.is_null() || CFArrayGetCount(points.0) == 0 {
            return Err(NativeError::new(
                "ENETWORK_CONNECT",
                "NetFS returned no mount point",
            ));
        }
        let mut buffer = [0_i8; 16384];
        if !CFStringGetCString(
            CFArrayGetValueAtIndex(points.0, 0),
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            UTF8,
        ) {
            return Err(NativeError::new(
                "ENETWORK_CONNECT",
                "Unable to read the mounted share path",
            ));
        }
        Ok(std::ffi::CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .into_owned())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_accept_credentials_in_smb_urls() {
        for value in [
            "smb://user:password@server/share",
            "smb://server",
            "smb://server/share?password=secret",
        ] {
            assert_eq!(connect_if_network(value, 0).unwrap_err().code, "EINVAL");
        }
    }
    #[test]
    fn regular_paths_keep_local_provider_semantics() {
        assert_eq!(
            connect_if_network("/Volumes/Share/folder", 0).unwrap(),
            "/Volumes/Share/folder"
        );
    }
}
