use std::{fs::File, io, path::Path};

/// Keep multi-gigabyte range fixtures sparse on Windows as well as Unix.
pub fn sparse_file(path: &Path, size: u64) -> io::Result<File> {
    let file = File::create(path)?;
    #[cfg(target_os = "windows")]
    {
        use std::{os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::System::{Ioctl::FSCTL_SET_SPARSE, IO::DeviceIoControl};
        let mut returned = 0;
        let success = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_SET_SPARSE,
                ptr::null(),
                0,
                ptr::null_mut(),
                0,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    file.set_len(size)?;
    Ok(file)
}
