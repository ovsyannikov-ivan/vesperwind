//! Logical sizes from metadata only. Never prepare or read file content.
use super::{paths, Filesystem};
use crate::{
    error::NativeError,
    remote::{RemoteProviders, SizeChildKind},
};
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeProgress {
    pub bytes: u64,
    pub items: u64,
    pub errors: u64,
    pub cancelled: bool,
}
struct Walker<'a, F: FnMut(&SizeProgress)> {
    result: SizeProgress,
    cancelled: &'a AtomicBool,
    last: Instant,
    progress: F,
}
impl<F: FnMut(&SizeProgress)> Walker<'_, F> {
    fn checkpoint(&mut self) -> bool {
        if self.last.elapsed() >= Duration::from_millis(100) {
            (self.progress)(&self.result);
            self.last = Instant::now();
        }
        !self.cancelled.load(Ordering::Acquire)
    }
    #[cfg(unix)]
    fn local(&mut self, fd: std::os::fd::OwnedFd, depth: usize) {
        use std::{ffi::CStr, os::fd::IntoRawFd};
        let raw = fd.into_raw_fd();
        let dir = unsafe { libc::fdopendir(raw) };
        if dir.is_null() {
            unsafe { libc::close(raw) };
            self.result.errors += 1;
            return;
        }
        // fdopendir owns the descriptor; every exit below closes it.
        while self.checkpoint() {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(dir) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                    self.result.errors += 1;
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            self.result.items += 1;
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatat(raw, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) }
                != 0
            {
                self.result.errors += 1;
                continue;
            }
            if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
                if depth >= 256 {
                    self.result.errors += 1;
                    continue;
                }
                let child = unsafe {
                    libc::openat(
                        raw,
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if child < 0 {
                    self.result.errors += 1;
                    continue;
                }
                use std::os::fd::FromRawFd;
                self.local(
                    unsafe { std::os::fd::OwnedFd::from_raw_fd(child) },
                    depth + 1,
                );
            } else {
                self.result.bytes = self.result.bytes.saturating_add(stat.st_size.max(0) as u64);
            }
        }
        unsafe {
            libc::closedir(dir);
        }
    }
    #[cfg(not(unix))]
    fn local(&mut self, root: &std::path::Path) {
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            if !self.checkpoint() {
                break;
            }
            // Do not descend symlinks/junctions. std metadata does not read data.
            let Ok(metadata) = std::fs::symlink_metadata(&directory) else {
                self.result.errors += 1;
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                self.result.errors += 1;
                continue;
            }
            let entries = match std::fs::read_dir(directory) {
                Ok(v) => v,
                Err(_) => {
                    self.result.errors += 1;
                    continue;
                }
            };
            for entry in entries {
                if !self.checkpoint() {
                    break;
                }
                self.result.items += 1;
                let metadata =
                    entry.and_then(|e| std::fs::symlink_metadata(e.path()).map(|m| (e.path(), m)));
                match metadata {
                    Ok((path, m)) if m.is_dir() && !m.file_type().is_symlink() => {
                        pending.push(path)
                    }
                    Ok((_, m)) => self.result.bytes = self.result.bytes.saturating_add(m.len()),
                    Err(_) => self.result.errors += 1,
                }
            }
        }
    }
}
pub fn calculate<F: FnMut(&SizeProgress)>(
    filesystem: &Filesystem,
    remote: &RemoteProviders,
    provider: &str,
    path: &str,
    cancelled: &AtomicBool,
    progress: F,
) -> Result<SizeProgress, NativeError> {
    let mut walker = Walker {
        result: SizeProgress::default(),
        cancelled,
        last: Instant::now(),
        progress,
    };
    if provider == "local" {
        let root = paths::resolve_metadata_path(filesystem, path)?;
        if !std::fs::symlink_metadata(&root)
            .map_err(|e| NativeError::from_io(&e, "Unable to inspect this folder"))?
            .is_dir()
        {
            return Err(NativeError::new(
                "ENOTDIR",
                "Select a directory, not a symbolic link",
            ));
        }
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::{fd::FromRawFd, unix::ffi::OsStrExt},
            };
            let name = CString::new(root.as_os_str().as_bytes())
                .map_err(|_| NativeError::new("EINVAL", "Invalid path"))?;
            let fd = unsafe {
                libc::open(
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(NativeError::from_io(
                    &std::io::Error::last_os_error(),
                    "Unable to inspect this folder",
                ));
            }
            walker.local(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }, 0);
        }
        #[cfg(not(unix))]
        walker.local(&root);
    } else {
        let root = remote.properties(provider, path)?;
        if root.entry_type != "directory" {
            return Err(NativeError::new(
                "ENOTDIR",
                "Directory attributes are not provided by this server",
            ));
        }
        let mut pending = vec![path.to_owned()];
        while let Some(directory) = pending.pop() {
            if !walker.checkpoint() {
                break;
            }
            match remote.size_children(provider, &directory) {
                Ok(children) => {
                    for child in children {
                        if !walker.checkpoint() {
                            break;
                        }
                        walker.result.items += 1;
                        match child.kind {
                            SizeChildKind::Directory => pending.push(child.path),
                            SizeChildKind::File => {
                                if let Some(size) = child.size {
                                    walker.result.bytes = walker.result.bytes.saturating_add(size);
                                } else {
                                    walker.result.errors += 1;
                                }
                            }
                            _ => walker.result.errors += 1,
                        }
                    }
                }
                Err(_) => walker.result.errors += 1,
            }
        }
    }
    walker.result.cancelled = cancelled.load(Ordering::Acquire);
    (walker.progress)(&walker.result);
    Ok(walker.result)
}
// The walk test needs Unix symlinks and file descriptors; on other targets
// the module would only import unused items.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn metadata_only_walk_never_follows_links_and_can_cancel() {
        let root = std::env::temp_dir().join(format!("vesper-size-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/file"), [0u8; 19]).unwrap();
        std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let ssh = crate::remote::RemoteProviders::new(crate::ssh::SshManager::new());
        let flag = AtomicBool::new(false);
        let result = calculate(
            &filesystem,
            &ssh,
            "local",
            root.to_str().unwrap(),
            &flag,
            |_| {},
        )
        .unwrap();
        assert_eq!(result.items, 3);
        assert_eq!(result.errors, 0);
        assert_eq!(
            result.bytes,
            19 + std::fs::symlink_metadata(root.join("cycle")).unwrap().len()
        );
        flag.store(true, Ordering::Release);
        assert!(
            calculate(
                &filesystem,
                &ssh,
                "local",
                root.to_str().unwrap(),
                &flag,
                |_| {}
            )
            .unwrap()
            .cancelled
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
