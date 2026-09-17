use super::{paths, Filesystem};
use crate::error::NativeError;
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AvailabilityState {
    Ready,
    Materializing,
    Failed,
}

#[derive(Debug)]
pub(crate) enum Inspection {
    Ready,
    Materializing {
        progress: Option<f64>,
        activity_marker: Option<u64>,
    },
    NotAvailable {
        progress: Option<f64>,
        activity_marker: Option<u64>,
    },
    Failed(NativeError),
}

#[derive(Debug)]
pub(crate) enum PrepareOnce {
    Ready(PathBuf),
    Materializing {
        path: PathBuf,
        progress: Option<f64>,
        activity_marker: Option<u64>,
    },
}

pub(crate) fn resolve_file(
    filesystem: &Filesystem,
    provider_id: Option<&str>,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    Filesystem::require_local(provider_id)?;
    let resolved = paths::resolve_inside_root(filesystem, requested)?;
    let real = paths::verify_existing_inside_root(filesystem, &resolved)
        .map_err(|error| normalize_path_error(error, requested))?;
    let metadata = fs::metadata(&real).map_err(|error| availability_io_error(&error, &real))?;

    if !metadata.is_file() {
        return Err(
            NativeError::new("EFILE_IO", "The requested path is not a file").with_path(&real),
        );
    }

    eprintln!(
        "[content-availability] requested_path={requested:?} decoded_path={:?} real_path={:?} exists=true metadata_available=true size={} result=validated",
        resolved,
        real,
        metadata.len()
    );
    Ok(real)
}

pub(crate) fn prepare_once(
    filesystem: &Filesystem,
    provider_id: Option<&str>,
    requested: &str,
    request_materialization: bool,
) -> Result<PrepareOnce, NativeError> {
    let real = resolve_file(filesystem, provider_id, requested)?;
    match inspect(&real)? {
        Inspection::Ready => {
            log_state(requested, &real, AvailabilityState::Ready, None, None);
            Ok(PrepareOnce::Ready(real))
        }
        Inspection::Materializing {
            progress,
            activity_marker,
        } => {
            log_state(
                requested,
                &real,
                AvailabilityState::Materializing,
                progress,
                None,
            );
            Ok(PrepareOnce::Materializing {
                path: real,
                progress,
                activity_marker,
            })
        }
        Inspection::NotAvailable {
            progress,
            activity_marker,
        } => {
            if request_materialization {
                request_download(&real)?;
            }
            log_state(
                requested,
                &real,
                AvailabilityState::Materializing,
                progress,
                None,
            );
            Ok(PrepareOnce::Materializing {
                path: real,
                progress,
                activity_marker,
            })
        }
        Inspection::Failed(error) => {
            log_state(
                requested,
                &real,
                AvailabilityState::Failed,
                None,
                Some(&error),
            );
            Err(error)
        }
    }
}

pub fn require_content_ready(
    filesystem: &Filesystem,
    provider_id: Option<&str>,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    match prepare_once(filesystem, provider_id, requested, true)? {
        PrepareOnce::Ready(path) => Ok(path),
        PrepareOnce::Materializing { path, .. } => Err(NativeError::new(
            "ECONTENT_MATERIALIZING",
            "This file is still being prepared. Try again when preparation completes.",
        )
        .with_path(path)),
    }
}

fn inspect(path: &Path) -> Result<Inspection, NativeError> {
    let metadata = fs::metadata(path).map_err(|error| availability_io_error(&error, path))?;

    #[cfg(target_os = "macos")]
    if let Some(inspection) = macos::inspect(path, &metadata)? {
        return Ok(inspection);
    }

    match probe_readable(path, metadata.len()) {
        Ok(()) => Ok(Inspection::Ready),
        Err(error) => Ok(Inspection::Failed(error)),
    }
}

fn probe_readable(path: &Path, length: u64) -> Result<(), NativeError> {
    let mut file = File::open(path).map_err(|error| availability_io_error(&error, path))?;
    if length > 0 {
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte)
            .map_err(|error| availability_io_error(&error, path))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn request_download(path: &Path) -> Result<(), NativeError> {
    macos::request_download(path)
}

#[cfg(not(target_os = "macos"))]
fn request_download(path: &Path) -> Result<(), NativeError> {
    Err(NativeError::new(
        "ECLOUD_NOT_LOCAL",
        "This cloud file is not available locally",
    )
    .with_path(path))
}

fn normalize_path_error(error: NativeError, path: &str) -> NativeError {
    let (code, message) = match error.code.as_str() {
        "ENOENT" => ("EFILE_NOT_FOUND", "File no longer exists"),
        "EACCES" | "EPERM" => ("EFILE_PERMISSION", "Permission denied"),
        _ => return error,
    };
    NativeError::new(code, message).with_path(path)
}

fn availability_io_error(error: &std::io::Error, path: &Path) -> NativeError {
    let (code, message) = match error.kind() {
        std::io::ErrorKind::NotFound => ("EFILE_NOT_FOUND", "File no longer exists"),
        std::io::ErrorKind::PermissionDenied => ("EFILE_PERMISSION", "Permission denied"),
        _ => ("EFILE_IO", "Unable to read this file"),
    };
    let native = match error.raw_os_error() {
        Some(errno) => format!("errno={errno}: {error}"),
        None => error.to_string(),
    };
    NativeError::new(code, message)
        .with_path(path)
        .with_native_error(native)
}

fn log_state(
    requested: &str,
    path: &Path,
    state: AvailabilityState,
    progress: Option<f64>,
    error: Option<&NativeError>,
) {
    eprintln!(
        "[content-availability] requested_path={requested:?} decoded_path={requested:?} real_path={path:?} state={state:?} progress={progress:?} native_error={:?}",
        error.and_then(|value| value.native_error.as_deref())
    );
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod macos {
    use super::{probe_readable, Inspection};
    use crate::error::NativeError;
    use objc2::{rc::autoreleasepool, runtime::AnyObject};
    use objc2_foundation::{
        NSError, NSFileCoordinator, NSFileCoordinatorReadingOptions, NSFileManager, NSNumber,
        NSString, NSURLUbiquitousItemDownloadingErrorKey,
        NSURLUbiquitousItemDownloadingStatusCurrent,
        NSURLUbiquitousItemDownloadingStatusDownloaded, NSURLUbiquitousItemDownloadingStatusKey,
        NSURLUbiquitousItemDownloadingStatusNotDownloaded, NSURLUbiquitousItemIsDownloadingKey,
        NSURLUbiquitousItemPercentDownloadedKey, NSURL,
    };
    use std::{
        collections::HashMap,
        fs::Metadata,
        os::macos::fs::MetadataExt,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
    };

    const SF_DATALESS: u32 = 0x4000_0000;

    #[derive(Debug)]
    enum CoordinatorState {
        Active,
        Failed(NativeError),
    }

    static COORDINATORS: OnceLock<Mutex<HashMap<PathBuf, CoordinatorState>>> = OnceLock::new();

    fn coordinators() -> &'static Mutex<HashMap<PathBuf, CoordinatorState>> {
        COORDINATORS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn inspect(
        path: &Path,
        metadata: &Metadata,
    ) -> Result<Option<Inspection>, NativeError> {
        autoreleasepool(|_| {
            let coordinator_state = {
                let mut workers = coordinators()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match workers.get(path) {
                    Some(CoordinatorState::Active) => Some(Ok(())),
                    Some(CoordinatorState::Failed(_)) => match workers.remove(path) {
                        Some(CoordinatorState::Failed(error)) => Some(Err(error)),
                        _ => None,
                    },
                    None => None,
                }
            };
            if let Some(Err(error)) = coordinator_state {
                return Ok(Some(Inspection::Failed(error)));
            }

            let url = file_url(path);
            let manager = NSFileManager::defaultManager();
            let ubiquitous = manager.isUbiquitousItemAtURL(&url);
            let dataless = metadata.st_flags() & SF_DATALESS != 0;

            if !ubiquitous && !dataless {
                return Ok(None);
            }

            if let Some(error) = resource_error(&url, path)? {
                return Ok(Some(Inspection::Failed(cloud_download_error(path, &error))));
            }

            // SAFETY: These immutable Foundation constants exist on every
            // supported macOS version.
            let (status, downloading, progress, current, downloaded, not_downloaded) = unsafe {
                (
                    resource_string(&url, NSURLUbiquitousItemDownloadingStatusKey, path)?,
                    resource_bool(&url, NSURLUbiquitousItemIsDownloadingKey, path)?
                        .unwrap_or(false),
                    resource_number(&url, NSURLUbiquitousItemPercentDownloadedKey, path)?
                        .map(|value| (value / 100.0).clamp(0.0, 1.0)),
                    NSURLUbiquitousItemDownloadingStatusCurrent.to_string(),
                    NSURLUbiquitousItemDownloadingStatusDownloaded.to_string(),
                    NSURLUbiquitousItemDownloadingStatusNotDownloaded.to_string(),
                )
            };

            if downloading {
                return Ok(Some(Inspection::Materializing {
                    progress,
                    activity_marker: Some(metadata.st_blocks()),
                }));
            }

            if matches!(coordinator_state, Some(Ok(()))) {
                return Ok(Some(Inspection::Materializing {
                    progress,
                    activity_marker: Some(metadata.st_blocks()),
                }));
            }

            if matches!(status.as_deref(), Some(value) if value == current || value == downloaded)
                && !dataless
            {
                return probe_readable(path, metadata.len())
                    .map(|_| Some(Inspection::Ready))
                    .or_else(|error| Ok(Some(Inspection::Failed(error))));
            }

            if dataless
                || status.is_none()
                || matches!(status.as_deref(), Some(value) if value == not_downloaded)
            {
                return Ok(Some(Inspection::NotAvailable {
                    progress,
                    activity_marker: Some(metadata.st_blocks()),
                }));
            }

            Ok(Some(Inspection::NotAvailable {
                progress,
                activity_marker: Some(metadata.st_blocks()),
            }))
        })
    }

    pub(super) fn request_download(path: &Path) -> Result<(), NativeError> {
        autoreleasepool(|_| {
            let url = file_url(path);
            match NSFileManager::defaultManager().startDownloadingUbiquitousItemAtURL_error(&url) {
                Ok(()) => Ok(()),
                Err(error)
                    if error.domain().to_string() == "NSCocoaErrorDomain"
                        && error.code() == 4099 =>
                {
                    start_coordinated_download(path);
                    Ok(())
                }
                Err(error) => Err(cloud_download_error(path, &error)),
            }
        })
    }

    fn start_coordinated_download(path: &Path) {
        let path = path.to_path_buf();
        {
            let mut workers = coordinators()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(workers.get(&path), Some(CoordinatorState::Active)) {
                return;
            }
            workers.insert(path.clone(), CoordinatorState::Active);
        }

        std::thread::spawn(move || {
            let result = coordinate_read(&path);
            let mut workers = coordinators()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match result {
                Ok(()) => {
                    workers.remove(&path);
                    eprintln!("[content-availability] real_path={path:?} coordinator=completed");
                }
                Err(error) => {
                    eprintln!(
                        "[content-availability] real_path={path:?} coordinator=failed error={error:?}"
                    );
                    workers.insert(path, CoordinatorState::Failed(error));
                }
            }
        });
    }

    fn coordinate_read(path: &Path) -> Result<(), NativeError> {
        autoreleasepool(|_| {
            let url = file_url(path);
            let coordinator = NSFileCoordinator::new();
            let reader = block2::StackBlock::new(|_coordinated_url| {});
            let mut error = None;
            coordinator.coordinateReadingItemAtURL_options_error_byAccessor(
                &url,
                NSFileCoordinatorReadingOptions::empty(),
                Some(&mut error),
                &reader,
            );
            match error {
                Some(error) => {
                    let metadata = std::fs::metadata(path)
                        .map_err(|io_error| super::availability_io_error(&io_error, path))?;
                    if metadata.st_flags() & SF_DATALESS == 0
                        && probe_readable(path, metadata.len()).is_ok()
                    {
                        eprintln!(
                            "[content-availability] real_path={path:?} coordinator_native_error={} postcondition=READY",
                            error.localizedDescription()
                        );
                        Ok(())
                    } else {
                        Err(cloud_download_error(path, &error))
                    }
                }
                None => Ok(()),
            }
        })
    }

    fn file_url(path: &Path) -> objc2::rc::Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn resource_value(
        url: &NSURL,
        key: &objc2_foundation::NSURLResourceKey,
        path: &Path,
    ) -> Result<Option<objc2::rc::Retained<AnyObject>>, NativeError> {
        let mut value = None;
        // SAFETY: Foundation documents the concrete value type for each key;
        // callers validate it with a dynamic downcast.
        unsafe { url.getResourceValue_forKey_error(&mut value, key) }.map_err(|error| {
            cloud_error(
                "ECLOUD_DOWNLOAD_FAILED",
                "Unable to inspect this cloud file",
                path,
                &error,
            )
        })?;
        Ok(value)
    }

    fn resource_string(
        url: &NSURL,
        key: &objc2_foundation::NSURLResourceKey,
        path: &Path,
    ) -> Result<Option<String>, NativeError> {
        Ok(resource_value(url, key, path)?
            .and_then(|value| value.downcast::<NSString>().ok())
            .map(|value| value.to_string()))
    }

    fn resource_bool(
        url: &NSURL,
        key: &objc2_foundation::NSURLResourceKey,
        path: &Path,
    ) -> Result<Option<bool>, NativeError> {
        Ok(resource_value(url, key, path)?
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|value| value.boolValue()))
    }

    fn resource_number(
        url: &NSURL,
        key: &objc2_foundation::NSURLResourceKey,
        path: &Path,
    ) -> Result<Option<f64>, NativeError> {
        Ok(resource_value(url, key, path)?
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|value| value.as_f64()))
    }

    fn resource_error(
        url: &NSURL,
        path: &Path,
    ) -> Result<Option<objc2::rc::Retained<NSError>>, NativeError> {
        // SAFETY: Immutable Foundation key available on supported macOS.
        unsafe {
            Ok(
                resource_value(url, NSURLUbiquitousItemDownloadingErrorKey, path)?
                    .and_then(|value| value.downcast::<NSError>().ok()),
            )
        }
    }

    fn cloud_error(code: &str, message: &str, path: &Path, error: &NSError) -> NativeError {
        NativeError::new(code, message)
            .with_path(path)
            .with_native_error(format!(
                "domain={} code={} description={}",
                error.domain(),
                error.code(),
                error.localizedDescription()
            ))
    }

    pub(super) fn cloud_download_error(path: &Path, error: &NSError) -> NativeError {
        let domain = error.domain().to_string();
        let code = error.code();
        let description = error.localizedDescription().to_string();
        let description_lower = description.to_lowercase();
        let offline = (domain == "NSURLErrorDomain"
            && matches!(code, -1001 | -1003 | -1004 | -1005 | -1009))
            || description_lower.contains("offline")
            || description_lower.contains("network connection")
            || description_lower.contains("internet connection");
        cloud_error(
            if offline {
                "ECLOUD_OFFLINE"
            } else {
                "ECLOUD_DOWNLOAD_FAILED"
            },
            if offline {
                "This file is stored in the cloud and is not available offline. Connect to the network and try again."
            } else {
                "Unable to download this cloud file"
            },
            path,
            error,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect, prepare_once, PrepareOnce};
    use crate::filesystem::Filesystem;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn local_unicode_file_is_ready_without_materialization() {
        let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "vesperwind-availability-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("Положение о Совете, 41.pdf");
        fs::write(&file, b"%PDF-1.7\n").unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();

        let available =
            prepare_once(&filesystem, Some("local"), &file.to_string_lossy(), true).unwrap();

        let canonical_file = fs::canonicalize(&file).unwrap();
        assert!(matches!(available, PrepareOnce::Ready(path) if path == canonical_file));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diagnoses_an_explicit_local_path_without_a_fixture_dependency() {
        let Ok(path) = std::env::var("VESPERWIND_DIAGNOSE_CONTENT_PATH") else {
            return;
        };
        let inspection = inspect(std::path::Path::new(&path)).unwrap();
        eprintln!("diagnostic_path={path:?} inspection={inspection:?}");
        if std::env::var_os("VESPERWIND_DIAGNOSE_REQUEST_DOWNLOAD").is_none() {
            return;
        }

        let root = std::path::Path::new(&path).parent().unwrap();
        let filesystem = Filesystem::from_root(root, root.to_path_buf()).unwrap();
        let started = std::time::Instant::now();
        let mut request = true;
        loop {
            let outcome = prepare_once(&filesystem, Some("local"), &path, request).unwrap();
            request = false;
            match outcome {
                PrepareOnce::Ready(_) => {
                    eprintln!(
                        "diagnostic_result=READY elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                    break;
                }
                PrepareOnce::Materializing { progress, .. } => {
                    eprintln!("diagnostic_result=MATERIALIZING progress={progress:?}");
                }
            }
            assert!(started.elapsed() < std::time::Duration::from_secs(180));
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_native_offline_error_to_controlled_cloud_error() {
        objc2::rc::autoreleasepool(|_| {
            use objc2_foundation::{NSError, NSString};

            let domain = NSString::from_str("NSURLErrorDomain");
            // SAFETY: A nil userInfo dictionary is valid for NSError and no
            // generic Objective-C object is supplied.
            let native = unsafe { NSError::errorWithDomain_code_userInfo(&domain, -1009, None) };
            let error = super::macos::cloud_download_error(
                std::path::Path::new("/tmp/cloud-only.pdf"),
                &native,
            );
            assert_eq!(error.code, "ECLOUD_OFFLINE");
            assert!(error.message.contains("not available offline"));
            assert!(error
                .native_error
                .as_deref()
                .is_some_and(|details| details.contains("code=-1009")));
        });
    }
}
