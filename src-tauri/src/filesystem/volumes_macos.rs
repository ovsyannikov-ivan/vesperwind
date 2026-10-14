//! Passive navigation metadata. Only already-mounted, visible volumes are
//! enumerated; no discovery, mounting, directory traversal or content reads.
use super::{directory_location, FileEntry, COMPUTER_PATH};
use objc2::{rc::autoreleasepool, runtime::AnyObject};
use objc2_foundation::{
    NSFileManager, NSNumber, NSString, NSURLResourceKey, NSURLVolumeIsLocalKey,
    NSURLVolumeLocalizedNameKey, NSVolumeEnumerationOptions, NSURL,
};
use serde_json::{json, Value};
use std::{ffi::c_void, path::Path};

fn resource(url: &NSURL, key: &NSURLResourceKey) -> Option<objc2::rc::Retained<AnyObject>> {
    let mut value = None;
    // SAFETY: Foundation returns a resource object; callers check its type.
    unsafe { url.getResourceValue_forKey_error(&mut value, key) }.ok()?;
    value
}

fn volume_name(url: &NSURL) -> Option<String> {
    // SAFETY: Immutable Foundation resource key on supported macOS versions.
    resource(url, unsafe { NSURLVolumeLocalizedNameKey })?
        .downcast::<NSString>()
        .ok()
        .map(|value| value.to_string())
}

pub fn root_name() -> String {
    autoreleasepool(|_| {
        volume_name(&NSURL::fileURLWithPath(&NSString::from_str("/")))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Local disk".into())
    })
}

pub fn computer_name() -> String {
    #[link(name = "SystemConfiguration", kind = "framework")]
    extern "C" {
        fn SCDynamicStoreCopyComputerName(
            store: *const c_void,
            encoding: *mut u32,
        ) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut i8,
            size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(value: *const c_void);
    }
    // SAFETY: NULL requests a temporary system session; the copied CFString
    // is released on every branch after conversion into an owned Rust string.
    unsafe {
        let value = SCDynamicStoreCopyComputerName(std::ptr::null(), std::ptr::null_mut());
        if value.is_null() {
            return "Mac".into();
        }
        let mut buffer = [0_i8; 8192];
        let converted = CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            0x08000100,
        );
        CFRelease(value);
        if converted {
            let name = std::ffi::CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned();
            if !name.is_empty() {
                return name;
            }
        }
        "Mac".into()
    }
}

pub fn mounted_volumes() -> Vec<FileEntry> {
    autoreleasepool(|_| {
        let mut volumes = vec![directory_location(&root_name(), "/", "volume")];
        if let Some(urls) = NSFileManager::defaultManager()
            .mountedVolumeURLsIncludingResourceValuesForKeys_options(
                None,
                NSVolumeEnumerationOptions::SkipHiddenVolumes,
            )
        {
            for url in urls.iter() {
                let Some(path) = url.path().map(|value| value.to_string()) else {
                    continue;
                };
                if path == "/" || volumes.iter().any(|entry| entry.path == path) {
                    continue;
                }
                let name = volume_name(&url).unwrap_or_else(|| {
                    Path::new(&path)
                        .file_name()
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.clone())
                });
                // SAFETY: Immutable key; Foundation documents an NSNumber result.
                let local = resource(&url, unsafe { NSURLVolumeIsLocalKey })
                    .and_then(|value| value.downcast::<NSNumber>().ok())
                    .map(|value| value.boolValue())
                    .unwrap_or(true);
                volumes.push(directory_location(
                    &name,
                    &path,
                    if local { "volume" } else { "network-volume" },
                ));
            }
        }
        volumes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        volumes
    })
}

pub fn navigation() -> Value {
    json!({"computer": directory_location(&computer_name(), COMPUTER_PATH, "computer"),
        "volumes": mounted_volumes()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_contains_the_named_system_volume_and_a_virtual_computer() {
        let navigation = navigation();
        assert_eq!(navigation["computer"]["path"], COMPUTER_PATH);
        assert!(!navigation["computer"]["name"].as_str().unwrap().is_empty());
        let volumes = navigation["volumes"].as_array().unwrap();
        let root = volumes.iter().find(|entry| entry["path"] == "/").unwrap();
        assert_eq!(root["name"], root_name());
        assert_ne!(root["name"], "/");
        assert!(volumes.iter().all(|entry| entry["isDirectory"] == true));
        let paths: std::collections::HashSet<_> = volumes
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths.len(), volumes.len());
    }
}
