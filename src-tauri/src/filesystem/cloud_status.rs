//! Lazy cloud status for the entries of a listed local folder.
//!
//! `Filesystem::list_directory` returns entries without any cloud inspection.
//! The frontend then asks for statuses here in small batches, after the rows
//! are on screen. Inspection stays passive: metadata only, never content,
//! hydration or a coordinated read. An absent status means "nothing to show",
//! never "verified local": opening a file still goes through `content.prepare`.
#[cfg(any(target_os = "macos", test))]
use super::{alias, format_time};
use super::{availability, paths, Filesystem, MetadataError};
use crate::error::NativeError;
use serde::Serialize;
#[cfg(any(target_os = "macos", test))]
use std::fs;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
};

/// Upper bound of one request; the frontend sends far smaller batches.
pub const MAX_BATCH: usize = 256;
/// Background batches running at once across all panels and windows, so cloud
/// diagnostics never occupy more than a couple of blocking workers.
const MAX_CONCURRENT_BATCHES: usize = 2;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub path: String,
    /// The modification time of the metadata that was inspected, so a status
    /// is never applied to an entry that has since been replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_availability: Option<availability::ContentAvailability>,
    #[cfg(target_os = "windows")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_sync: Option<availability::onedrive::CloudSync>,
    /// This entry could not be inspected; the rest of the batch is unaffected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MetadataError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusBatch {
    pub statuses: Vec<CloudStatus>,
    /// No entry of this folder can have a cloud status (Windows: outside every
    /// registered OneDrive root), so the remaining batches can be skipped.
    pub complete: bool,
}

pub(crate) fn cancelled_error() -> NativeError {
    NativeError::new("ECANCELLED", "The cloud status request was cancelled")
}

type Child = (String, Result<PathBuf, NativeError>);

/// Resolve the folder once and accept only its direct children, so a batch
/// can never inspect anything outside the listed folder or the root.
fn children(
    filesystem: &Filesystem,
    directory: &str,
    requested: &[String],
) -> Result<(PathBuf, PathBuf, Vec<Child>), NativeError> {
    if requested.len() > MAX_BATCH {
        return Err(NativeError::new(
            "EINVAL",
            "Too many entries in one cloud status request",
        ));
    }
    let logical = paths::resolve_inside_root(filesystem, directory)?;
    let real = paths::verify_existing_inside_root(filesystem, &logical)?;
    let children = requested
        .iter()
        .map(|path| {
            let child = paths::absolute_clean(Path::new(path)).and_then(|cleaned| {
                match (cleaned.parent(), cleaned.file_name()) {
                    (Some(parent), Some(name)) if parent == logical => Ok(real.join(name)),
                    _ => Err(NativeError::new("EINVAL", "This item is not in the folder")
                        .with_path(path)),
                }
            });
            (path.clone(), child)
        })
        .collect();
    Ok((logical, real, children))
}

/// Passive cloud status of `paths`, which must be entries of `directory`.
pub fn inspect(
    filesystem: &Filesystem,
    directory: &str,
    paths: &[String],
    cancelled: &AtomicBool,
) -> Result<CloudStatusBatch, NativeError> {
    let (logical, real, children) = children(filesystem, directory, paths)?;
    #[cfg(target_os = "macos")]
    {
        let _ = (logical, real);
        scan_entries(
            filesystem,
            children,
            cancelled,
            availability::inspect_content_availability,
        )
    }
    #[cfg(target_os = "windows")]
    {
        availability::onedrive::native::cloud_status(&real, &logical, children, cancelled)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (logical, real, cancelled);
        Ok(CloudStatusBatch {
            statuses: children
                .into_iter()
                .map(|(path, _)| CloudStatus {
                    path,
                    ..CloudStatus::default()
                })
                .collect(),
            complete: true,
        })
    }
}

/// Per-entry scan used on macOS, where cloud facts are per-file metadata.
/// Cancellation is checked between entries; a single OS call is not aborted.
#[cfg(any(target_os = "macos", test))]
fn scan_entries(
    filesystem: &Filesystem,
    children: Vec<Child>,
    cancelled: &AtomicBool,
    mut inspector: impl FnMut(&Path, &fs::Metadata) -> Option<availability::ContentAvailability>,
) -> Result<CloudStatusBatch, NativeError> {
    let mut statuses = Vec::with_capacity(children.len());
    for (path, child) in children {
        if cancelled.load(Ordering::Acquire) {
            return Err(cancelled_error());
        }
        let mut status = CloudStatus {
            path,
            ..CloudStatus::default()
        };
        match child.and_then(|child| inspected_target(filesystem, &child)) {
            Ok((target, metadata)) => {
                status.modified_at = metadata.modified().ok().map(format_time);
                if metadata.is_file() {
                    status.content_availability = inspector(&target, &metadata);
                }
            }
            Err(error) => status.error = Some(MetadataError { code: error.code }),
        }
        statuses.push(status);
    }
    Ok(CloudStatusBatch {
        statuses,
        complete: false,
    })
}

/// The path and metadata the listing used for this entry: the entry itself,
/// or the resolved target of a symlink or Finder Alias. A dataless alias is
/// inspected as itself, because resolving it would materialize its bookmark.
#[cfg(any(target_os = "macos", test))]
fn inspected_target(
    filesystem: &Filesystem,
    child: &Path,
) -> Result<(PathBuf, fs::Metadata), NativeError> {
    let io = |error: std::io::Error| NativeError::from_io(&error, "Unable to read metadata");
    let link = fs::symlink_metadata(child).map_err(io)?;
    let is_alias = link.is_file() && alias::is_finder_alias(child).unwrap_or(false);
    if !is_alias && !link.file_type().is_symlink() {
        return Ok((child.to_path_buf(), link));
    }
    #[cfg(target_os = "macos")]
    if is_alias && availability::is_dataless(&link) {
        return Ok((child.to_path_buf(), link));
    }
    let real = paths::verify_child_inside_root(filesystem, child)?;
    let metadata = fs::metadata(&real).map_err(io)?;
    Ok((real, metadata))
}

static RUNNING: Mutex<usize> = Mutex::new(0);
static AVAILABLE: Condvar = Condvar::new();

struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        *RUNNING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) -= 1;
        AVAILABLE.notify_one();
    }
}

/// Wait for one of the few background slots. A request cancelled while
/// waiting returns without touching the filesystem.
fn acquire(cancelled: &AtomicBool) -> Result<Permit, NativeError> {
    let mut running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(cancelled_error());
        }
        if *running < MAX_CONCURRENT_BATCHES {
            *running += 1;
            return Ok(Permit);
        }
        running = AVAILABLE
            .wait_timeout(running, std::time::Duration::from_millis(50))
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
}

/// `inspect`, limited to `MAX_CONCURRENT_BATCHES` concurrent batches.
pub fn inspect_limited(
    filesystem: &Filesystem,
    directory: &str,
    paths: &[String],
    cancelled: &AtomicBool,
) -> Result<CloudStatusBatch, NativeError> {
    let _permit = acquire(cancelled)?;
    inspect(filesystem, directory, paths, cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        time::{Duration, Instant},
    };

    struct Fixture {
        directory: PathBuf,
        filesystem: Filesystem,
    }
    impl Fixture {
        fn new(files: &[&str]) -> Self {
            let base = std::env::temp_dir()
                .join(format!("vesperwind-cloud-status-{}", uuid::Uuid::new_v4()));
            let directory = base.join("root");
            fs::create_dir_all(&directory).unwrap();
            for name in files {
                fs::write(directory.join(name), name.as_bytes()).unwrap();
            }
            let filesystem = Filesystem::from_root(&directory, directory.clone()).unwrap();
            Self {
                directory,
                filesystem,
            }
        }
        fn path(&self, name: &str) -> String {
            self.directory.join(name).to_string_lossy().into_owned()
        }
        fn scan(
            &self,
            names: &[&str],
            cancelled: &AtomicBool,
            inspector: impl FnMut(&Path, &fs::Metadata) -> Option<availability::ContentAvailability>,
        ) -> Result<CloudStatusBatch, NativeError> {
            let requested = names.iter().map(|name| self.path(name)).collect::<Vec<_>>();
            let (_, _, requested) = children(
                &self.filesystem,
                &self.directory.to_string_lossy(),
                &requested,
            )?;
            scan_entries(&self.filesystem, requested, cancelled, inspector)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.directory.parent().unwrap());
        }
    }

    fn cloud() -> Option<availability::ContentAvailability> {
        availability::ContentAvailability::test_cloud()
    }

    #[test]
    fn listing_returns_before_and_without_a_slow_inspector() {
        let names = (0..12)
            .map(|index| format!("file-{index}.txt"))
            .collect::<Vec<_>>();
        let fixture = Fixture::new(&names.iter().map(String::as_str).collect::<Vec<_>>());
        let before = availability::passive_inspections();
        let started = Instant::now();
        let entries = fixture
            .filesystem
            .list_directory(&fixture.directory.to_string_lossy())
            .unwrap();
        let listing = started.elapsed();
        assert_eq!(entries.len(), names.len());
        assert_eq!(availability::passive_inspections(), before);

        let delay = Duration::from_millis(60);
        let calls = Cell::new(0);
        let started = Instant::now();
        let batch = fixture
            .scan(
                &names.iter().map(String::as_str).collect::<Vec<_>>(),
                &AtomicBool::new(false),
                |_, _| {
                    calls.set(calls.get() + 1);
                    std::thread::sleep(delay);
                    None
                },
            )
            .unwrap();
        let scan = started.elapsed();
        assert_eq!(calls.get(), names.len());
        assert!(scan >= delay * names.len() as u32);
        // The listing is independent of the inspector's per-file cost: it is
        // shorter than even two simulated cloud queries.
        assert!(listing < delay * 2, "listing took {listing:?}");
        assert_eq!(batch.statuses.len(), names.len());
    }

    #[test]
    fn statuses_match_their_files_and_empty_status_is_a_result() {
        let fixture = Fixture::new(&["cloud.txt", "local.txt"]);
        let batch = fixture
            .scan(
                &["local.txt", "cloud.txt"],
                &AtomicBool::new(false),
                |path, _| {
                    (path.file_name().unwrap() == "cloud.txt")
                        .then(cloud)
                        .flatten()
                },
            )
            .unwrap();
        assert_eq!(batch.statuses[0].path, fixture.path("local.txt"));
        assert!(batch.statuses[0].content_availability.is_none());
        assert!(batch.statuses[0].error.is_none());
        assert!(batch.statuses[0].modified_at.is_some());
        assert_eq!(batch.statuses[1].path, fixture.path("cloud.txt"));
        assert_eq!(
            serde_json::to_value(&batch.statuses[1]).unwrap()["contentAvailability"],
            serde_json::json!({"state": "cloud"})
        );
        let local = serde_json::to_value(&batch.statuses[0]).unwrap();
        assert!(local.get("contentAvailability").is_none());
        assert!(local.get("error").is_none());
    }

    #[test]
    fn one_missing_entry_does_not_fail_the_batch() {
        let fixture = Fixture::new(&["a.txt", "c.txt"]);
        let batch = fixture
            .scan(
                &["a.txt", "gone.txt", "c.txt"],
                &AtomicBool::new(false),
                |_, _| cloud(),
            )
            .unwrap();
        assert!(batch.statuses[0].content_availability.is_some());
        assert_eq!(batch.statuses[1].error.as_ref().unwrap().code, "ENOENT");
        assert!(batch.statuses[1].content_availability.is_none());
        assert!(batch.statuses[2].content_availability.is_some());
    }

    #[test]
    fn cancellation_stops_before_the_next_entry() {
        let fixture = Fixture::new(&["a.txt", "b.txt", "c.txt"]);
        let cancelled = AtomicBool::new(false);
        let calls = Cell::new(0);
        let result = fixture.scan(&["a.txt", "b.txt", "c.txt"], &cancelled, |_, _| {
            calls.set(calls.get() + 1);
            cancelled.store(true, Ordering::Release);
            None
        });
        assert_eq!(result.unwrap_err().code, "ECANCELLED");
        assert_eq!(calls.get(), 1);
        // A request cancelled before it starts never takes a background slot.
        assert_eq!(
            inspect_limited(
                &fixture.filesystem,
                &fixture.directory.to_string_lossy(),
                &[fixture.path("a.txt")],
                &AtomicBool::new(true),
            )
            .unwrap_err()
            .code,
            "ECANCELLED"
        );
    }

    #[test]
    fn requests_cannot_leave_the_folder_or_the_root() {
        let fixture = Fixture::new(&["a.txt"]);
        let outside = fixture.directory.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        assert_eq!(
            inspect(
                &fixture.filesystem,
                &outside.to_string_lossy(),
                &[],
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "EOUTSIDE_ROOT"
        );
        let escaping = [
            outside.join("secret.txt").to_string_lossy().into_owned(),
            format!("{}/../outside/secret.txt", fixture.directory.display()),
            fixture.directory.to_string_lossy().into_owned(),
        ];
        let (_, _, requested) = children(
            &fixture.filesystem,
            &fixture.directory.to_string_lossy(),
            &escaping,
        )
        .unwrap();
        let batch = scan_entries(
            &fixture.filesystem,
            requested,
            &AtomicBool::new(false),
            |_, _| panic!("an escaping path must not be inspected"),
        )
        .unwrap();
        assert!(batch
            .statuses
            .iter()
            .all(|status| status.error.as_ref().unwrap().code == "EINVAL"));
        let oversized = vec![fixture.path("a.txt"); MAX_BATCH + 1];
        assert!(children(
            &fixture.filesystem,
            &fixture.directory.to_string_lossy(),
            &oversized
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_are_confined_and_never_opened() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = Fixture::new(&["target.txt"]);
        let outside = fixture.directory.parent().unwrap().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, fixture.directory.join("escape.txt")).unwrap();
        symlink(
            fixture.directory.join("target.txt"),
            fixture.directory.join("inside.txt"),
        )
        .unwrap();
        // Unreadable content: passive inspection needs metadata only.
        let target = fixture.directory.join("target.txt");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o000)).unwrap();
        let inspected = std::cell::RefCell::new(Vec::new());
        let batch = fixture
            .scan(
                &["escape.txt", "inside.txt"],
                &AtomicBool::new(false),
                |path, _| {
                    inspected.borrow_mut().push(path.to_path_buf());
                    None
                },
            )
            .unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            batch.statuses[0].error.as_ref().unwrap().code,
            "EOUTSIDE_ROOT"
        );
        assert!(batch.statuses[1].error.is_none());
        assert_eq!(
            inspected.into_inner(),
            vec![fs::canonicalize(&target).unwrap()]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_inspection_of_ordinary_local_files_reports_nothing() {
        let fixture = Fixture::new(&["a.txt", "b.txt"]);
        let batch = inspect(
            &fixture.filesystem,
            &fixture.directory.to_string_lossy(),
            &[fixture.path("a.txt"), fixture.path("b.txt")],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(!batch.complete);
        assert!(batch
            .statuses
            .iter()
            .all(|status| status.content_availability.is_none() && status.error.is_none()));
    }
}
