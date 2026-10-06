//! macOS disk images. macOS 27+ uses `diskutil image attach` / `diskutil
//! eject` (`hdiutil` is deprecated there); older systems use `hdiutil`.
//! All tool output is requested as a plist and decoded by Foundation.
use super::{
    mac_image_tool, parse_hdiutil_info, parse_ioreg_devices, parse_macos_version,
    parse_system_entities, whole_disk, DiskImageStatus, MacImageTool, MacOsVersion, MountedVolume,
};
use crate::error::NativeError;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    NSArray, NSData, NSDictionary, NSNumber, NSPropertyListReadOptions,
    NSPropertyListSerialization, NSString,
};
use serde_json::Value;
use std::{
    ffi::CStr,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

const SW_VERS: &str = "/usr/bin/sw_vers";
const DISKUTIL: &str = "/usr/sbin/diskutil";
const HDIUTIL: &str = "/usr/bin/hdiutil";
const IOREG: &str = "/usr/sbin/ioreg";
const TOOL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

fn version() -> Option<MacOsVersion> {
    static VERSION: OnceLock<Option<MacOsVersion>> = OnceLock::new();
    *VERSION.get_or_init(|| {
        let output = Command::new(SW_VERS)
            .arg("-productVersion")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        parse_macos_version(&String::from_utf8_lossy(&output.stdout))
    })
}

fn tool() -> MacImageTool {
    mac_image_tool(version())
}

/// Run an absolute-path tool with separate argv entries (no shell) and a
/// deadline. stdin is closed so an encrypted image cannot block on a prompt.
fn run<S: AsRef<std::ffi::OsStr>>(program: &str, args: &[S]) -> Result<Vec<u8>, NativeError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| NativeError::from_io(&error, "Unable to start the disk image tool"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stdout
            .by_ref()
            .take(64 * 1024 * 1024)
            .read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stderr.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NativeError::new(
                    "ETIMEDOUT",
                    "The disk image tool did not respond",
                ));
            }
            Err(error) => {
                return Err(NativeError::from_io(
                    &error,
                    "Unable to monitor the disk image tool",
                ))
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        let details = String::from_utf8_lossy(&stderr).trim().to_string();
        Err(NativeError::new(
            "EDISK_IMAGE",
            "macOS could not complete the disk image operation",
        )
        .with_native_error(if details.is_empty() {
            status.to_string()
        } else {
            details
        }))
    }
}

/// Decode an XML/binary plist with Foundation into JSON values.
fn plist(bytes: &[u8]) -> Result<Value, NativeError> {
    let data = NSData::with_bytes(bytes);
    // SAFETY: `data` is a valid NSData; a null format pointer is permitted.
    let object = unsafe {
        NSPropertyListSerialization::propertyListWithData_options_format_error(
            &data,
            NSPropertyListReadOptions::Immutable,
            std::ptr::null_mut(),
        )
    }
    .map_err(|error| {
        NativeError::new(
            "EDISK_IMAGE",
            "The disk image tool returned unreadable output",
        )
        .with_native_error(error.localizedDescription().to_string())
    })?;
    Ok(to_json(&object))
}

fn to_json(object: &AnyObject) -> Value {
    if let Some(string) = object.downcast_ref::<NSString>() {
        return Value::String(string.to_string());
    }
    if let Some(number) = object.downcast_ref::<NSNumber>() {
        // Plist booleans are CFBoolean, encoded as "c".
        // SAFETY: objCType returns a static NUL-terminated type encoding.
        let encoding = unsafe { CStr::from_ptr(number.objCType().as_ptr()) };
        return match encoding.to_bytes() {
            b"c" | b"B" => Value::Bool(number.boolValue()),
            b"f" | b"d" => serde_json::Number::from_f64(number.doubleValue())
                .map(Value::Number)
                .unwrap_or(Value::Null),
            _ => Value::from(number.longLongValue()),
        };
    }
    if let Some(array) = object.downcast_ref::<NSArray>() {
        return Value::Array(array.iter().map(|item| to_json(&item)).collect());
    }
    if let Some(dictionary) = object.downcast_ref::<NSDictionary>() {
        let mut map = serde_json::Map::new();
        for key in dictionary.allKeys() {
            if let (Some(name), Some(value)) = (
                key.downcast_ref::<NSString>(),
                dictionary.objectForKey(&key),
            ) {
                map.insert(name.to_string(), to_json(&value));
            }
        }
        return Value::Object(map);
    }
    Value::Null
}

/// Mounted file systems by device node (`/dev/disk4s1` -> `/Volumes/X`).
fn mount_points() -> Vec<(String, String)> {
    let mut entries: *mut libc::statfs = std::ptr::null_mut();
    // SAFETY: getmntinfo stores a pointer to an internal buffer owned by libc
    // and returns its element count; it is read before any further call.
    let count = unsafe { libc::getmntinfo(&mut entries, libc::MNT_NOWAIT) };
    if count <= 0 || entries.is_null() {
        return vec![];
    }
    // SAFETY: getmntinfo returned `count` initialized statfs records.
    let entries = unsafe { std::slice::from_raw_parts(entries, count as usize) };
    entries
        .iter()
        .map(|entry| {
            // SAFETY: both fields are NUL-terminated fixed-size C strings.
            let from = unsafe { CStr::from_ptr(entry.f_mntfromname.as_ptr()) };
            let on = unsafe { CStr::from_ptr(entry.f_mntonname.as_ptr()) };
            (
                from.to_string_lossy().into_owned(),
                on.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

pub fn status(image: &Path) -> Result<DiskImageStatus, NativeError> {
    let detached = DiskImageStatus {
        image_path: image.to_string_lossy().into_owned(),
        ..Default::default()
    };
    match tool() {
        MacImageTool::Diskutil => {
            let output = run(IOREG, &["-a", "-r", "-c", "AppleDiskImageDevice", "-l"])?;
            if output.iter().all(u8::is_ascii_whitespace) {
                return Ok(detached);
            }
            let Some(devices) = parse_ioreg_devices(image, &plist(&output)?) else {
                return Ok(detached);
            };
            let mounted = mount_points();
            let volumes = devices
                .iter()
                .flat_map(|device| {
                    mounted
                        .iter()
                        .filter(move |(from, _)| from == device)
                        .map(|(from, on)| MountedVolume {
                            device: Some(from.clone()),
                            mount_point: on.clone(),
                            name: Path::new(on)
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned()),
                        })
                })
                .collect();
            Ok(DiskImageStatus {
                attached: true,
                device: devices.first().map(|device| whole_disk(device)),
                volumes,
                ..detached
            })
        }
        MacImageTool::Hdiutil => {
            let output = run(HDIUTIL, &["info", "-plist"])?;
            Ok(parse_hdiutil_info(image, &plist(&output)?).unwrap_or(detached))
        }
    }
}

pub fn mount(image: &Path) -> Result<DiskImageStatus, NativeError> {
    let output = match tool() {
        MacImageTool::Diskutil => run(
            DISKUTIL,
            &[
                std::ffi::OsStr::new("image"),
                "attach".as_ref(),
                "--plist".as_ref(),
                image.as_os_str(),
            ],
        )?,
        MacImageTool::Hdiutil => run(
            HDIUTIL,
            &[
                std::ffi::OsStr::new("attach"),
                "-plist".as_ref(),
                image.as_os_str(),
            ],
        )?,
    };
    parse_system_entities(image, &plist(&output)?)
        .ok_or_else(|| NativeError::new("EDISK_IMAGE", "macOS did not report the attached device"))
}

pub fn unmount(image: &Path, current: &DiskImageStatus) -> Result<DiskImageStatus, NativeError> {
    let device = current
        .device
        .clone()
        .ok_or_else(|| NativeError::new("EDISK_IMAGE", "The attached device is unknown"))?;
    match tool() {
        // `diskutil image detach` is not the replacement; eject is.
        MacImageTool::Diskutil => run(DISKUTIL, &["eject", device.as_str()])?,
        MacImageTool::Hdiutil => run(HDIUTIL, &["detach", device.as_str()])?,
    };
    Ok(DiskImageStatus {
        image_path: image.to_string_lossy().into_owned(),
        ..Default::default()
    })
}
