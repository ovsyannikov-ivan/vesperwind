//! Opt-in listing cost breakdown. Not a CI timing assertion: run with
//! `cargo test listing_profile -- --ignored --nocapture`, optionally with
//! `VESPERWIND_LISTING_PROFILE_DIRS` (paths separated by `\n`) for real folders.
use super::{alias, availability, paths, Filesystem};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const ITERATIONS: usize = 5;

fn median(mut values: Vec<Duration>) -> f64 {
    values.sort();
    values[values.len() / 2].as_secs_f64() * 1000.0
}

fn measure(label: &str, directory: &Path, mut phase: impl FnMut() -> usize) -> f64 {
    let mut samples = Vec::new();
    let mut count = 0;
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        count = phase();
        samples.push(started.elapsed());
    }
    let value = median(samples);
    eprintln!(
        "listing_profile directory={:?} phase={label} items={count} median_ms={value:.2}",
        directory.file_name().unwrap_or_default()
    );
    value
}

fn profile(filesystem: &Filesystem, directory: &Path) {
    let names = || {
        fs::read_dir(directory)
            .unwrap()
            .map(|item| item.unwrap().path())
            .collect::<Vec<PathBuf>>()
    };
    let items = names();
    measure("read_dir_names", directory, || names().len());
    measure("symlink_metadata", directory, || {
        items
            .iter()
            .filter(|path| fs::symlink_metadata(path).is_ok())
            .count()
    });
    measure("finder_alias_check", directory, || {
        items
            .iter()
            .filter(|path| alias::is_finder_alias(path).is_ok())
            .count()
    });
    measure("verify_inside_root", directory, || {
        items
            .iter()
            .filter(|path| paths::verify_existing_inside_root(filesystem, path).is_ok())
            .count()
    });
    measure("canonicalize_only", directory, || {
        items
            .iter()
            .filter(|path| fs::canonicalize(path).is_ok())
            .count()
    });
    measure("target_metadata", directory, || {
        items
            .iter()
            .filter(|path| fs::metadata(path).is_ok())
            .count()
    });
    measure("cloud_inspection", directory, || {
        items
            .iter()
            .filter_map(|path| Some((path, fs::metadata(path).ok()?)))
            .filter(|(_, metadata)| metadata.is_file())
            .inspect(|(path, metadata)| {
                let _ = availability::inspect_content_availability(path, metadata);
            })
            .count()
    });
    let mut serialized = 0;
    measure("list_directory_total", directory, || {
        let entries = filesystem
            .list_directory(&directory.to_string_lossy())
            .unwrap();
        serialized = serde_json::to_vec(&entries).unwrap().len();
        entries.len()
    });
    let entries = filesystem
        .list_directory(&directory.to_string_lossy())
        .unwrap();
    measure("serialize_json", directory, || {
        serde_json::to_vec(&entries).unwrap().len()
    });
    eprintln!(
        "listing_profile directory={:?} json_bytes={serialized}",
        directory.file_name().unwrap_or_default()
    );
}

#[test]
#[ignore = "opt-in listing cost breakdown, not a CI timing assertion"]
fn listing_profile() {
    let filesystem = Filesystem::desktop(dirs::home_dir().unwrap()).unwrap();
    if let Ok(directories) = std::env::var("VESPERWIND_LISTING_PROFILE_DIRS") {
        for directory in directories.lines().filter(|line| !line.is_empty()) {
            profile(&filesystem, Path::new(directory));
        }
        return;
    }
    let fixture = std::env::temp_dir().join(format!(
        "vesperwind-listing-profile-{}",
        uuid::Uuid::new_v4()
    ));
    for count in [100, 500, 1000, 3000] {
        let directory = fixture.join(format!("local-{count}"));
        fs::create_dir_all(&directory).unwrap();
        for index in 0..count {
            fs::write(directory.join(format!("file-{index:04}.txt")), b"local").unwrap();
        }
        profile(&filesystem, &directory);
    }
    fs::remove_dir_all(fixture).unwrap();
}

#[test]
#[ignore = "opt-in iCloud metadata key cost breakdown"]
fn icloud_key_profile() {
    use objc2::{rc::autoreleasepool, runtime::AnyObject};
    use objc2_foundation::{
        NSArray, NSFileManager, NSString, NSURLUbiquitousItemDownloadingErrorKey,
        NSURLUbiquitousItemDownloadingStatusKey, NSURLUbiquitousItemIsDownloadingKey, NSURL,
    };
    let directory = std::env::var("VESPERWIND_LISTING_PROFILE_DIRS").expect("set a directory");
    let items = fs::read_dir(directory.lines().next().unwrap())
        .unwrap()
        .map(|item| item.unwrap().path())
        .collect::<Vec<_>>();
    let url = |path: &Path| NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    measure("is_ubiquitous", Path::new(&directory), || {
        autoreleasepool(|_| {
            let manager = NSFileManager::defaultManager();
            items
                .iter()
                .filter(|path| manager.isUbiquitousItemAtURL(&url(path)))
                .count()
        })
    });
    // SAFETY: immutable public Foundation keys.
    let keys = unsafe {
        [
            NSURLUbiquitousItemIsDownloadingKey,
            NSURLUbiquitousItemDownloadingStatusKey,
            NSURLUbiquitousItemDownloadingErrorKey,
        ]
    };
    measure("three_single_keys", Path::new(&directory), || {
        autoreleasepool(|_| {
            items
                .iter()
                .map(|path| {
                    let url = url(path);
                    for key in keys {
                        let mut value: Option<objc2::rc::Retained<AnyObject>> = None;
                        let _ = unsafe { url.getResourceValue_forKey_error(&mut value, key) };
                    }
                })
                .count()
        })
    });
    measure("directory_prefetch", Path::new(&directory), || {
        autoreleasepool(|_| {
            let array = NSArray::from_slice(&keys);
            let urls = NSFileManager::defaultManager()
                .contentsOfDirectoryAtURL_includingPropertiesForKeys_options_error(
                    &url(Path::new(directory.lines().next().unwrap())),
                    Some(&array),
                    objc2_foundation::NSDirectoryEnumerationOptions::empty(),
                )
                .unwrap();
            urls.iter()
                .filter(|url| url.resourceValuesForKeys_error(&array).is_ok())
                .count()
        })
    });
    measure("one_multi_key_call", Path::new(&directory), || {
        autoreleasepool(|_| {
            let array = NSArray::from_slice(&keys);
            items
                .iter()
                .filter(|path| url(path).resourceValuesForKeys_error(&array).is_ok())
                .count()
        })
    });
}
