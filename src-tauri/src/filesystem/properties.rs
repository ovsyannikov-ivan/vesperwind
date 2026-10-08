use super::{paths, Filesystem};
use crate::error::NativeError;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: &'static str,
    pub size: Option<u64>,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub accessed_at: Option<String>,
    pub target: Option<String>,
    pub permissions: Option<Permissions>,
    pub permissions_message: Option<&'static str>,
    pub capabilities: Capabilities,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub metadata_warnings: Vec<NativeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_availability: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_sync: Option<serde_json::Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub mode: Option<u32>,
    pub mode_octal: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner_name: Option<String>,
    pub group_name: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub calculate_size: bool,
    pub change_mode: bool,
    pub change_owner: bool,
    pub change_group: bool,
    pub preview: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionUpdate {
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}
impl PermissionUpdate {
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.mode.is_some_and(|mode| mode > 0o7777)
            || self.uid == Some(u32::MAX)
            || self.gid == Some(u32::MAX)
            || (self.mode.is_none() && self.uid.is_none() && self.gid.is_none())
        {
            return Err(NativeError::new("EINVAL", "Invalid permissions update"));
        }
        Ok(())
    }
}
pub fn preserve_mode(original: u32, requested: u32) -> u32 {
    // The editor changes only rwx; file type and setuid/setgid/sticky survive.
    (original & !0o777) | (requested & 0o777)
}
fn timestamp(value: Option<u64>) -> Option<String> {
    value
        .and_then(|v| i64::try_from(v).ok())
        .and_then(|v| chrono::DateTime::from_timestamp(v, 0))
        .map(|v| v.to_rfc3339())
}
pub fn from_sftp(path: &str, stat: &ssh2::FileStat, target: Option<String>) -> Properties {
    let kind = match stat.perm.map(|m| m & 0o170000) {
        Some(0o040000) => "directory",
        Some(0o120000) => "symlink",
        Some(0o100000) => "file",
        _ => "unknown",
    };
    let writable = matches!(kind, "file" | "directory");
    Properties {
        name: Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.into()),
        path: path.into(),
        entry_type: kind,
        size: (kind != "directory").then_some(stat.size).flatten(),
        created_at: None,
        modified_at: timestamp(stat.mtime),
        accessed_at: timestamp(stat.atime),
        target,
        permissions: Some(Permissions {
            mode: stat.perm,
            mode_octal: stat.perm.map(|m| format!("{:o}", m & 0o7777)),
            uid: stat.uid,
            gid: stat.gid,
            owner_name: None,
            group_name: None,
        }),
        permissions_message: if kind == "symlink" {
            Some("Symbolic link permissions are read-only; the target is never changed.")
        } else if stat.perm.is_none() {
            Some("Permissions are not provided by this SFTP server")
        } else if kind == "unknown" {
            Some("The server does not provide a safe entry type; attributes are read-only.")
        } else {
            None
        },
        capabilities: Capabilities {
            calculate_size: kind == "directory",
            change_mode: writable && stat.perm.is_some(),
            change_owner: writable && stat.uid.is_some() && stat.gid.is_some(),
            change_group: writable && stat.uid.is_some() && stat.gid.is_some(),
            preview: kind == "file",
        },
        content_availability: None,
        cloud_sync: None,
        metadata_warnings: Vec::new(),
    }
}
pub fn sftp_update(
    stat: &ssh2::FileStat,
    update: &PermissionUpdate,
) -> Result<ssh2::FileStat, NativeError> {
    update.validate()?;
    if !matches!(stat.perm.map(|m| m & 0o170000), Some(0o100000 | 0o040000)) {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Permissions cannot be safely changed for this entry",
        ));
    }
    if (update.uid.is_some() || update.gid.is_some()) && (stat.uid.is_none() || stat.gid.is_none())
    {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Ownership is not provided by this SFTP server",
        ));
    }
    // UID/GID are one SFTP v3 attribute pair. Preserve an unchanged partner
    // explicitly; ssh2 otherwise serializes a missing partner as zero.
    // Never send timestamps or size back with SETSTAT.
    Ok(ssh2::FileStat {
        size: None,
        uid: if update.uid.is_some() || update.gid.is_some() {
            update.uid.or(stat.uid)
        } else {
            None
        },
        gid: if update.uid.is_some() || update.gid.is_some() {
            update.gid.or(stat.gid)
        } else {
            None
        },
        perm: update.mode.map(|m| preserve_mode(stat.perm.unwrap(), m)),
        atime: None,
        mtime: None,
    })
}
pub fn read(filesystem: &Filesystem, requested: &str) -> Result<Properties, NativeError> {
    let path = paths::resolve_metadata_path(filesystem, requested)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|e| NativeError::from_io(&e, "Unable to read properties").with_path(requested))?;
    let link = metadata.file_type().is_symlink();
    let alias =
        !link && metadata.is_file() && super::alias::is_finder_alias(&path).unwrap_or(false);
    let kind = if alias {
        "alias"
    } else if link {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::MetadataExt;
        Some(Permissions {
            mode: Some(metadata.mode()),
            mode_octal: Some(format!("{:o}", metadata.mode() & 0o7777)),
            uid: Some(metadata.uid()),
            gid: Some(metadata.gid()),
            owner_name: unix_name(metadata.uid(), false),
            group_name: unix_name(metadata.gid(), true),
        })
    };
    #[cfg(not(unix))]
    let permissions = None;
    let mut result = Properties {
        name: Path::new(requested)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| requested.into()),
        path: requested.into(),
        entry_type: kind,
        size: (!metadata.is_dir()).then_some(metadata.len()),
        created_at: metadata.created().ok().map(super::format_time),
        modified_at: metadata.modified().ok().map(super::format_time),
        accessed_at: metadata.accessed().ok().map(super::format_time),
        target: if link {
            fs::read_link(&path)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        },
        permissions,
        permissions_message: if alias {
            Some("Finder alias properties are read-only; its target is not resolved.")
        } else if link {
            Some("Symbolic link permissions are read-only; the target is never changed.")
        } else if cfg!(windows) {
            Some("Windows security permissions editing is not available yet.")
        } else {
            None
        },
        capabilities: Capabilities {
            calculate_size: kind == "directory",
            change_mode: cfg!(unix) && matches!(kind, "file" | "directory"),
            change_owner: cfg!(unix) && matches!(kind, "file" | "directory"),
            change_group: cfg!(unix) && matches!(kind, "file" | "directory"),
            preview: kind == "file",
        },
        content_availability: None,
        cloud_sync: None,
        metadata_warnings: Vec::new(),
    };
    #[cfg(target_os = "macos")]
    if !link && metadata.is_file() {
        result.content_availability =
            super::availability::inspect_content_availability(&path, &metadata)
                .and_then(|v| serde_json::to_value(v).ok());
    }
    #[cfg(windows)]
    if !link && metadata.is_file() {
        match super::availability::onedrive::native::inspect_passive(&path) {
            Ok((availability, sync)) => {
                result.content_availability =
                    availability.and_then(|v| serde_json::to_value(v).ok());
                result.cloud_sync = sync.and_then(|v| serde_json::to_value(v).ok());
            }
            Err(error) => result.metadata_warnings.push(error),
        }
    }
    // Other platforms do not have native cloud metadata.
    let _ = &mut result;
    Ok(result)
}

#[cfg(unix)]
fn unix_name(id: u32, group: bool) -> Option<String> {
    use std::{ffi::CStr, ptr};
    let mut buffer = vec![0u8; 1024];
    loop {
        let (code, name) = unsafe {
            // Reentrant POSIX lookup; returned strings are copied before the buffer drops.
            if group {
                let mut record: libc::group = std::mem::zeroed();
                let mut found = ptr::null_mut();
                let code = libc::getgrgid_r(
                    id,
                    &mut record,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                );
                (
                    code,
                    if code == 0 && !found.is_null() && !record.gr_name.is_null() {
                        Some(
                            CStr::from_ptr(record.gr_name)
                                .to_string_lossy()
                                .into_owned(),
                        )
                    } else {
                        None
                    },
                )
            } else {
                let mut record: libc::passwd = std::mem::zeroed();
                let mut found = ptr::null_mut();
                let code = libc::getpwuid_r(
                    id,
                    &mut record,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                );
                (
                    code,
                    if code == 0 && !found.is_null() && !record.pw_name.is_null() {
                        Some(
                            CStr::from_ptr(record.pw_name)
                                .to_string_lossy()
                                .into_owned(),
                        )
                    } else {
                        None
                    },
                )
            }
        };
        if code != libc::ERANGE || buffer.len() >= 1024 * 1024 {
            return name;
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}
pub fn update(
    filesystem: &Filesystem,
    requested: &str,
    update: &PermissionUpdate,
) -> Result<Properties, NativeError> {
    update.validate()?;
    #[cfg(target_os = "macos")]
    {
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::MetadataExt},
        };
        let path = paths::resolve_metadata_path(filesystem, requested)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| NativeError::from_io(&e, "Unable to read properties"))?;
        if (!metadata.is_file() && !metadata.is_dir())
            || super::alias::is_finder_alias(&path).unwrap_or(false)
        {
            return Err(NativeError::new(
                "ENOTSUPPORTED",
                "Link and special-file permissions are read-only",
            ));
        }
        let name = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| NativeError::new("EINVAL", "Invalid path"))?;
        let check = |code| {
            if code == 0 {
                Ok(())
            } else {
                Err(NativeError::from_io(
                    &std::io::Error::last_os_error(),
                    "Permission denied or permissions could not be changed",
                )
                .with_path(requested))
            }
        };
        // macOS open(O_EVTONLY) still requires read permission. The no-follow
        // *at syscalls preserve chmod/chown semantics even for mode 000 files,
        // and never open cloud file content or mutate a link target.
        if update.uid.is_some() || update.gid.is_some() {
            check(unsafe {
                libc::fchownat(
                    libc::AT_FDCWD,
                    name.as_ptr(),
                    update.uid.unwrap_or(u32::MAX),
                    update.gid.unwrap_or(u32::MAX),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            })?;
        }
        if let Some(mode) = update.mode {
            check(unsafe {
                libc::fchmodat(
                    libc::AT_FDCWD,
                    name.as_ptr(),
                    (preserve_mode(metadata.mode(), mode) & 0o7777) as libc::mode_t,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            })?;
        }
        read(filesystem, requested)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::{
            ffi::CString,
            os::unix::{
                ffi::OsStrExt,
                io::{AsRawFd, FromRawFd},
            },
        };
        let path = paths::resolve_metadata_path(filesystem, requested)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| NativeError::from_io(&e, "Unable to read properties"))?;
        if (!metadata.is_file() && !metadata.is_dir())
            || super::alias::is_finder_alias(&path).unwrap_or(false)
        {
            return Err(NativeError::new(
                "ENOTSUPPORTED",
                "Link and special-file permissions are read-only",
            ));
        }
        let name = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| NativeError::new("EINVAL", "Invalid path"))?;
        #[cfg(target_os = "macos")]
        let access = libc::O_EVTONLY;
        #[cfg(not(target_os = "macos"))]
        let access = libc::O_RDONLY | libc::O_NONBLOCK;
        // No-follow descriptor pins the selected inode. O_EVTONLY does not read
        // cloud content; chmod/chown never open or change a symlink target.
        let fd = unsafe { libc::open(name.as_ptr(), access | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(NativeError::from_io(
                &std::io::Error::last_os_error(),
                "Unable to change permissions",
            )
            .with_path(requested));
        }
        let file = unsafe { fs::File::from_raw_fd(fd) };
        let current = file
            .metadata()
            .map_err(|e| NativeError::from_io(&e, "Unable to read permissions"))?;
        use std::os::unix::fs::MetadataExt;
        if current.ino() != metadata.ino() || current.dev() != metadata.dev() {
            return Err(NativeError::new(
                "ESTALE",
                "This entry changed; reload its properties",
            ));
        }
        let check = |code| {
            if code == 0 {
                Ok(())
            } else {
                Err(NativeError::from_io(
                    &std::io::Error::last_os_error(),
                    "Permission denied or permissions could not be changed",
                )
                .with_path(requested))
            }
        };
        if update.uid.is_some() || update.gid.is_some() {
            check(unsafe {
                libc::fchown(
                    file.as_raw_fd(),
                    update.uid.unwrap_or(u32::MAX),
                    update.gid.unwrap_or(u32::MAX),
                )
            })?;
        }
        if let Some(mode) = update.mode {
            check(unsafe {
                libc::fchmod(
                    file.as_raw_fd(),
                    (preserve_mode(current.mode(), mode) & 0o7777) as libc::mode_t,
                )
            })?;
        }
        read(filesystem, requested)
    }
    #[cfg(not(unix))]
    {
        let _ = (filesystem, requested);
        Err(NativeError::new(
            "ENOTSUPPORTED",
            "Windows security permissions editing is not available yet",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stat() -> ssh2::FileStat {
        ssh2::FileStat {
            size: Some(17),
            uid: Some(1000),
            gid: Some(1001),
            perm: Some(0o100640),
            atime: Some(2),
            mtime: Some(3),
        }
    }
    #[test]
    fn sftp_representation_and_sparse_updates() {
        let p = from_sftp("/report", &stat(), None);
        assert_eq!(p.created_at, None);
        assert_eq!(p.entry_type, "file");
        assert_eq!(p.permissions.unwrap().mode_octal.as_deref(), Some("640"));
        let update = sftp_update(
            &stat(),
            &PermissionUpdate {
                mode: Some(0o750),
                uid: None,
                gid: None,
            },
        )
        .unwrap();
        assert_eq!(update.perm, Some(0o100750));
        assert_eq!(update.uid, None);
        assert_eq!(update.size, None);
        assert_eq!(update.mtime, None);
        assert_eq!(update.atime, None);
        let update = sftp_update(
            &stat(),
            &PermissionUpdate {
                mode: None,
                uid: Some(1002),
                gid: Some(1003),
            },
        )
        .unwrap();
        assert_eq!(update.perm, None);
        assert_eq!(update.uid, Some(1002));
        assert_eq!(update.gid, Some(1003));
        let uid_only = sftp_update(
            &stat(),
            &PermissionUpdate {
                mode: None,
                uid: Some(2000),
                gid: None,
            },
        )
        .unwrap();
        assert_eq!(uid_only.uid, Some(2000));
        assert_eq!(uid_only.gid, Some(1001));
        assert_eq!(uid_only.perm, None);
        assert_eq!(preserve_mode(0o104640, 0o750), 0o104750);
        let mut missing = stat();
        missing.perm = None;
        missing.uid = None;
        missing.gid = None;
        let p = from_sftp("/report", &missing, None);
        assert!(!p.capabilities.change_mode);
        assert!(!p.capabilities.change_owner);
        missing.perm = Some(0o120777);
        assert!(sftp_update(
            &missing,
            &PermissionUpdate {
                mode: Some(0o640),
                uid: None,
                gid: None
            }
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn local_permissions_and_link_target_protection() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!("vesper-properties-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("file");
        fs::write(&file, b"fixture").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        assert_eq!(
            read(&filesystem, file.to_str().unwrap())
                .unwrap()
                .permissions
                .unwrap()
                .mode
                .unwrap()
                & 0o777,
            0o640
        );
        update(
            &filesystem,
            file.to_str().unwrap(),
            &PermissionUpdate {
                mode: Some(0o750),
                uid: None,
                gid: None,
            },
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o750
        );
        let link = root.join("link");
        symlink(&file, &link).unwrap();
        assert_eq!(
            read(&filesystem, link.to_str().unwrap())
                .unwrap()
                .entry_type,
            "symlink"
        );
        assert!(update(
            &filesystem,
            link.to_str().unwrap(),
            &PermissionUpdate {
                mode: Some(0o777),
                uid: None,
                gid: None
            }
        )
        .is_err());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o750
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_metadata_only_chmod_and_denied_owner_change() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root =
            std::env::temp_dir().join(format!("vesper-properties-macos-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("file");
        fs::write(&path, b"do not read content").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0)).unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let before = read(&filesystem, path.to_str().unwrap()).unwrap();
        assert!(before.created_at.is_some());
        assert!(before.modified_at.is_some());
        assert!(before.permissions.unwrap().owner_name.is_some());
        update(
            &filesystem,
            path.to_str().unwrap(),
            &PermissionUpdate {
                mode: Some(0o640),
                uid: None,
                gid: None,
            },
        )
        .unwrap();
        let directory = root.join("directory");
        fs::create_dir(&directory).unwrap();
        let child = directory.join("child");
        fs::write(&child, b"child").unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o640)).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            read(&filesystem, directory.to_str().unwrap())
                .unwrap()
                .permissions
                .unwrap()
                .mode
                .unwrap()
                & 0o777,
            0o640
        );
        update(
            &filesystem,
            directory.to_str().unwrap(),
            &PermissionUpdate {
                mode: Some(0o750),
                uid: None,
                gid: None,
            },
        )
        .unwrap();
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o777, 0o750);
        assert_eq!(fs::metadata(&child).unwrap().mode() & 0o777, 0o640);
        if unsafe { libc::geteuid() } != 0 {
            let result = update(
                &filesystem,
                path.to_str().unwrap(),
                &PermissionUpdate {
                    mode: None,
                    uid: Some(0),
                    gid: None,
                },
            )
            .unwrap_err();
            assert_eq!(result.code, "EACCES");
            assert_eq!(fs::metadata(&path).unwrap().uid(), unsafe {
                libc::geteuid()
            });
        }
        fs::remove_dir_all(root).unwrap();
    }
}
