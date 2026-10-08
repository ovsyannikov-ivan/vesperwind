use super::{paths, Filesystem};
use crate::error::NativeError;
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[cfg(any(target_os = "windows", test))]
pub(crate) mod onedrive;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AvailabilityState {
    Ready,
    Materializing,
    Failed,
}

/// A passive representation of local content availability, not sync/upload status.
/// Ready and unknown are omitted from listings; neither is a cloud-only claim.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
#[derive(Debug, Serialize)]
pub struct ContentAvailability {
    #[serde(flatten)]
    status: ContentAvailabilityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'static str>,
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum ContentAvailabilityStatus {
    Cloud,
    Materializing {
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<f64>,
    },
    Failed,
    #[cfg(any(target_os = "windows", test))]
    NotReady,
}

#[cfg(target_os = "windows")]
impl ContentAvailability {
    pub(crate) fn mark_onedrive_materializing(&mut self, progress: Option<f64>) {
        if self.provider == Some("onedrive")
            && matches!(
                self.status,
                ContentAvailabilityStatus::Cloud | ContentAvailabilityStatus::NotReady
            )
        {
            self.status = ContentAvailabilityStatus::Materializing { progress };
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl ContentAvailability {
    fn from_inspection(inspection: Inspection) -> Option<Self> {
        match inspection {
            Inspection::Ready | Inspection::Unknown { .. } => None,
            Inspection::NotAvailable { .. } => Some(Self {
                status: ContentAvailabilityStatus::Cloud,
                provider: None,
            }),
            Inspection::Materializing { progress, .. } => Some(Self {
                status: ContentAvailabilityStatus::Materializing { progress },
                provider: None,
            }),
            Inspection::Failed(_) => Some(Self {
                status: ContentAvailabilityStatus::Failed,
                provider: None,
            }),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default, Clone, Copy)]
enum DownloadStatus {
    #[default]
    Unknown,
    NotDownloaded,
    Local,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct CloudMetadata {
    ubiquitous: bool,
    dataless: bool,
    downloading: bool,
    coordinator_active: bool,
    status: DownloadStatus,
    progress: Option<f64>,
    activity_marker: Option<u64>,
    inspection_error: Option<NativeError>,
    download_error: Option<NativeError>,
}

#[cfg(any(target_os = "macos", test))]
fn classify_metadata(metadata: CloudMetadata) -> Inspection {
    let progress = metadata
        .progress
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0));
    let activity_marker = metadata.activity_marker;
    if metadata.downloading || metadata.coordinator_active {
        return Inspection::Materializing {
            progress,
            activity_marker,
        };
    }
    if !metadata.dataless
        && (!metadata.ubiquitous || matches!(metadata.status, DownloadStatus::Local))
    {
        // A stale download error must not mark already-local bytes unavailable.
        return Inspection::Ready;
    }
    if let Some(error) = metadata.download_error {
        return Inspection::Failed(error);
    }
    if metadata.dataless || matches!(metadata.status, DownloadStatus::NotDownloaded) {
        // SF_DATALESS remains strong evidence even if NSURL keys are unavailable.
        return Inspection::NotAvailable {
            progress,
            activity_marker,
        };
    }
    if let Some(error) = metadata.inspection_error {
        return Inspection::Failed(error);
    }
    Inspection::Unknown { activity_marker }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum InspectionMode {
    Passive,
    Preparing,
}

/// Metadata only. Never opens content, requests a download or coordinates a read.
#[cfg(target_os = "macos")]
pub(crate) fn inspect_content_availability(
    path: &Path,
    metadata: &fs::Metadata,
) -> Option<ContentAvailability> {
    ContentAvailability::from_inspection(macos::inspect(path, metadata, InspectionMode::Passive))
}

#[cfg(target_os = "macos")]
pub(crate) fn is_dataless(metadata: &fs::Metadata) -> bool {
    macos::is_dataless(metadata)
}

#[derive(Debug)]
// Cloud-only states are constructed by the macOS implementation. Other
// platforms still match them in the shared state machine.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum Inspection {
    Ready,
    #[cfg(any(target_os = "macos", test))]
    Unknown {
        activity_marker: Option<u64>,
    },
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
        #[cfg(target_os = "windows")]
        hydration: Option<std::sync::Arc<onedrive::native::Hydration>>,
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
                #[cfg(target_os = "windows")]
                hydration: None,
            })
        }
        Inspection::NotAvailable {
            progress,
            activity_marker,
        } => {
            #[cfg(target_os = "windows")]
            let hydration = if request_materialization {
                Some(onedrive::native::Hydration::start(&real)?)
            } else {
                None
            };
            #[cfg(not(target_os = "windows"))]
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
                #[cfg(target_os = "windows")]
                hydration,
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
        #[cfg(any(target_os = "macos", test))]
        Inspection::Unknown { .. } => unreachable!("active inspection normalizes unknown metadata"),
    }
}

pub fn require_content_ready(
    filesystem: &Filesystem,
    provider_id: Option<&str>,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    match prepare_once(filesystem, provider_id, requested, true)? {
        PrepareOnce::Ready(path) => Ok(path),
        PrepareOnce::Materializing {
            path,
            #[cfg(target_os = "windows")]
            hydration,
            ..
        } => {
            #[cfg(target_os = "windows")]
            if let Some(hydration) = hydration {
                hydration.wait()?;
                if matches!(inspect(&path)?, Inspection::Ready) {
                    return Ok(path);
                }
            }
            Err(NativeError::new(
                "ECONTENT_MATERIALIZING",
                "This file is still being prepared. Try again when preparation completes.",
            )
            .with_path(path))
        }
    }
}

fn inspect(path: &Path) -> Result<Inspection, NativeError> {
    let metadata = fs::metadata(path).map_err(|error| availability_io_error(&error, path))?;

    #[cfg(target_os = "windows")]
    if let Some(inspection) = onedrive::native::inspect_preparing(path, &metadata)? {
        return Ok(inspection);
    }

    #[cfg(target_os = "macos")]
    match macos::inspect(path, &metadata, InspectionMode::Preparing) {
        Inspection::Ready => {}
        // Preserve the existing preparation fallback for ambiguous iCloud metadata.
        Inspection::Unknown { activity_marker } => {
            return Ok(Inspection::NotAvailable {
                progress: None,
                activity_marker,
            })
        }
        inspection => return Ok(inspection),
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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    use super::{
        classify_metadata, probe_readable, CloudMetadata, DownloadStatus, Inspection,
        InspectionMode,
    };
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

    pub(super) fn is_dataless(metadata: &Metadata) -> bool {
        metadata.st_flags() & SF_DATALESS != 0
    }

    #[derive(Debug)]
    enum CoordinatorState {
        Active,
        Failed(NativeError),
    }

    static COORDINATORS: OnceLock<Mutex<HashMap<PathBuf, CoordinatorState>>> = OnceLock::new();

    fn coordinators() -> &'static Mutex<HashMap<PathBuf, CoordinatorState>> {
        COORDINATORS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn inspect(path: &Path, metadata: &Metadata, mode: InspectionMode) -> Inspection {
        autoreleasepool(|_| {
            let coordinator_state = {
                let mut workers = coordinators()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match workers.get(path) {
                    Some(CoordinatorState::Active) => Some(Ok(())),
                    Some(CoordinatorState::Failed(error)) => {
                        let error = error.clone();
                        if matches!(mode, InspectionMode::Preparing) {
                            workers.remove(path);
                        }
                        Some(Err(error))
                    }
                    None => None,
                }
            };
            let url = file_url(path);
            let manager = NSFileManager::defaultManager();
            let ubiquitous = manager.isUbiquitousItemAtURL(&url);
            let dataless = is_dataless(metadata);

            if !ubiquitous && !dataless {
                return match coordinator_state {
                    Some(Ok(())) => Inspection::Materializing {
                        progress: None,
                        activity_marker: Some(metadata.st_blocks()),
                    },
                    Some(Err(error)) => Inspection::Failed(error),
                    None => Inspection::Ready,
                };
            }
            let mut facts = CloudMetadata {
                ubiquitous,
                dataless,
                coordinator_active: matches!(coordinator_state, Some(Ok(()))),
                download_error: coordinator_state.and_then(Result::err),
                activity_marker: Some(metadata.st_blocks()),
                ..CloudMetadata::default()
            };
            // Only cloud candidates need the additional NSURL resource values.
            // Keep partial evidence when a key fails, especially SF_DATALESS.
            let resources = (|| -> Result<(), NativeError> {
                // SAFETY: Immutable public Foundation keys exist on supported macOS versions.
                unsafe {
                    facts.downloading =
                        resource_bool(&url, NSURLUbiquitousItemIsDownloadingKey, path)?
                            .unwrap_or(false);
                    let status =
                        resource_string(&url, NSURLUbiquitousItemDownloadingStatusKey, path)?;
                    facts.status = download_status(status.as_deref());
                    if facts.downloading || facts.coordinator_active {
                        facts.progress =
                            resource_number(&url, NSURLUbiquitousItemPercentDownloadedKey, path)?
                                .map(|value| value / 100.0);
                    }
                }
                if let Some(error) = resource_error(&url, path)? {
                    facts.download_error = Some(cloud_download_error(path, &error));
                }
                Ok(())
            })();
            facts.inspection_error = resources.err();
            classify_metadata(facts)
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

    pub(super) fn download_status(status: Option<&str>) -> DownloadStatus {
        // SAFETY: Public immutable Foundation status constants are available on macOS.
        unsafe {
            match status {
                Some(value)
                    if value == NSURLUbiquitousItemDownloadingStatusCurrent.to_string()
                        || value == NSURLUbiquitousItemDownloadingStatusDownloaded.to_string() =>
                {
                    DownloadStatus::Local
                }
                Some(value)
                    if value == NSURLUbiquitousItemDownloadingStatusNotDownloaded.to_string() =>
                {
                    DownloadStatus::NotDownloaded
                }
                _ => DownloadStatus::Unknown,
            }
        }
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
    use super::{
        classify_metadata, inspect, prepare_once, CloudMetadata, ContentAvailability,
        DownloadStatus, Inspection, PrepareOnce,
    };
    use crate::filesystem::Filesystem;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    fn serialized_metadata(metadata: CloudMetadata) -> serde_json::Value {
        serde_json::to_value(ContentAvailability::from_inspection(classify_metadata(
            metadata,
        )))
        .unwrap()
    }

    #[test]
    fn listing_availability_serializes_only_absent_downloading_or_failed_content() {
        use serde_json::json;
        assert_eq!(serialized_metadata(CloudMetadata::default()), json!(null));
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                dataless: true,
                ..CloudMetadata::default()
            }),
            json!({"state": "cloud"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                status: DownloadStatus::NotDownloaded,
                ..CloudMetadata::default()
            }),
            json!({"state": "cloud"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                downloading: true,
                progress: Some(0.42),
                ..CloudMetadata::default()
            }),
            json!({"state": "materializing", "progress": 0.42})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                downloading: true,
                ..CloudMetadata::default()
            }),
            json!({"state": "materializing"})
        );
        // Current and Downloaded both map to Local in the Foundation adapter.
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                status: DownloadStatus::Local,
                ..CloudMetadata::default()
            }),
            json!(null)
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                status: DownloadStatus::Local,
                dataless: true,
                ..CloudMetadata::default()
            }),
            json!({"state": "cloud"})
        );
        // Mere membership in iCloud with missing keys is unknown, not cloud-only.
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                ..CloudMetadata::default()
            }),
            json!(null)
        );
    }

    #[test]
    fn metadata_failures_keep_strong_dataless_and_partial_download_evidence() {
        use serde_json::json;
        let error =
            || crate::error::NativeError::new("ECLOUD_DOWNLOAD_FAILED", "Metadata unavailable");
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                inspection_error: Some(error()),
                ..CloudMetadata::default()
            }),
            json!({"state": "failed"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                dataless: true,
                inspection_error: Some(error()),
                ..CloudMetadata::default()
            }),
            json!({"state": "cloud"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                downloading: true,
                inspection_error: Some(error()),
                ..CloudMetadata::default()
            }),
            json!({"state": "materializing"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                dataless: true,
                download_error: Some(error()),
                ..CloudMetadata::default()
            }),
            json!({"state": "failed"})
        );
        assert_eq!(
            serialized_metadata(CloudMetadata {
                ubiquitous: true,
                status: DownloadStatus::Local,
                download_error: Some(error()),
                ..CloudMetadata::default()
            }),
            json!(null)
        );
    }

    #[test]
    fn coordinator_activity_and_finite_progress_share_preparation_semantics() {
        use serde_json::json;
        for progress in [None, Some(f64::NAN), Some(f64::INFINITY)] {
            assert_eq!(
                serialized_metadata(CloudMetadata {
                    ubiquitous: true,
                    dataless: true,
                    coordinator_active: true,
                    progress,
                    ..CloudMetadata::default()
                }),
                json!({"state": "materializing"})
            );
        }
        for (progress, expected) in [(-0.2, 0.0), (1.2, 1.0)] {
            assert_eq!(
                serialized_metadata(CloudMetadata {
                    downloading: true,
                    progress: Some(progress),
                    ..CloudMetadata::default()
                }),
                json!({"state": "materializing", "progress": expected})
            );
        }
        assert!(matches!(
            classify_metadata(CloudMetadata {
                dataless: true,
                activity_marker: Some(128),
                ..CloudMetadata::default()
            }),
            Inspection::NotAvailable {
                activity_marker: Some(128),
                ..
            }
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn passive_inspection_never_probes_file_content() {
        let path =
            std::env::temp_dir().join(format!("vesperwind-passive-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"local content").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        fs::remove_file(&path).unwrap();
        // Even a now-missing path cannot make passive metadata open/read bytes.
        assert!(super::inspect_content_availability(&path, &metadata).is_none());
        assert!(inspect(&path).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn foundation_current_and_downloaded_are_local_but_not_downloaded_is_cloud() {
        use objc2_foundation::{
            NSURLUbiquitousItemDownloadingStatusCurrent,
            NSURLUbiquitousItemDownloadingStatusDownloaded,
            NSURLUbiquitousItemDownloadingStatusNotDownloaded,
        };
        // SAFETY: Test only reads public immutable Foundation constants.
        unsafe {
            for value in [
                NSURLUbiquitousItemDownloadingStatusCurrent,
                NSURLUbiquitousItemDownloadingStatusDownloaded,
            ] {
                let status = super::macos::download_status(Some(&value.to_string()));
                assert!(matches!(status, DownloadStatus::Local));
                assert_eq!(
                    serialized_metadata(CloudMetadata {
                        ubiquitous: true,
                        status,
                        ..CloudMetadata::default()
                    }),
                    serde_json::Value::Null
                );
            }
            let status = super::macos::download_status(Some(
                &NSURLUbiquitousItemDownloadingStatusNotDownloaded.to_string(),
            ));
            assert!(matches!(status, DownloadStatus::NotDownloaded));
            assert_eq!(
                serialized_metadata(CloudMetadata {
                    ubiquitous: true,
                    status,
                    ..CloudMetadata::default()
                }),
                serde_json::json!({"state": "cloud"})
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opt-in passive diagnostics on a real local/iCloud directory"]
    fn diagnose_passive_directory_listing() {
        use std::{os::macos::fs::MetadataExt, path::Path};
        let directory =
            std::env::var("VESPERWIND_DIAGNOSE_LIST_DIRECTORY").expect("set a directory path");
        let filesystem = Filesystem::desktop(dirs::home_dir().unwrap()).unwrap();
        let flags = || {
            fs::read_dir(&directory)
                .unwrap()
                .filter_map(|item| {
                    let path = item.ok()?.path();
                    let metadata = fs::symlink_metadata(&path).ok()?;
                    Some((path, (metadata.st_flags(), metadata.st_blocks())))
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let before = flags();
        let started = std::time::Instant::now();
        let entries = filesystem.list_directory(&directory).unwrap();
        eprintln!(
            "passive_listing directory={directory:?} count={} elapsed_ms={} entries={}",
            entries.len(),
            started.elapsed().as_millis(),
            serde_json::to_string(&entries).unwrap()
        );
        assert_eq!(before, flags(), "listing must not materialize entries");
        for entry in entries
            .iter()
            .filter(|entry| !entry.is_symbolic_link && !entry.is_directory)
        {
            let path = Path::new(&entry.path);
            let metadata = fs::metadata(path).unwrap();
            if super::is_dataless(&metadata) {
                assert!(entry.content_availability.is_some());
            }
        }
    }

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
        #[cfg(target_os = "windows")]
        let mut hydration_request: Option<
            std::sync::Arc<super::onedrive::native::Hydration>,
        > = None;
        loop {
            #[cfg(target_os = "windows")]
            if let Some(hydration) = &hydration_request {
                hydration.status().unwrap();
            }
            let outcome = prepare_once(&filesystem, Some("local"), &path, request).unwrap();
            request = false;
            match outcome {
                PrepareOnce::Ready(_) => {
                    #[cfg(target_os = "windows")]
                    if let Some(hydration) = &hydration_request {
                        hydration.wait().unwrap();
                    }
                    eprintln!(
                        "diagnostic_result=READY elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                    break;
                }
                PrepareOnce::Materializing {
                    progress,
                    #[cfg(target_os = "windows")]
                    hydration,
                    ..
                } => {
                    #[cfg(target_os = "windows")]
                    if hydration.is_some() {
                        // Keep native I/O alive across this opt-in diagnostic's
                        // polling iterations, just as ContentManager does.
                        hydration_request = hydration;
                    }
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
