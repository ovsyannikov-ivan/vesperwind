use crate::{
    error::NativeError,
    filesystem::{
        availability::{prepare_once, AvailabilityState, PrepareOnce},
        Filesystem,
    },
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

// This is an inactivity watchdog, not a total download timeout. Any reported
// percentage increase or increase in locally materialized blocks resets it.
const STALLED_ACTIVITY_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
struct Operation {
    filesystem_id: String,
    path: String,
    started: Instant,
    last_progress: Option<f64>,
    last_activity_marker: Option<u64>,
    last_activity_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPreparation {
    pub state: AvailabilityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub progress: Option<f64>,
    pub user_message: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Default)]
pub struct ContentManager {
    operations: Mutex<HashMap<String, Operation>>,
}

impl ContentManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn prepare(
        &self,
        filesystem: &Filesystem,
        filesystem_id: Option<&str>,
        path: &str,
    ) -> Result<ContentPreparation, NativeError> {
        match prepare_once(filesystem, filesystem_id, path, true)? {
            PrepareOnce::Ready(_) => Ok(ready(0)),
            PrepareOnce::Materializing {
                progress,
                activity_marker,
                ..
            } => {
                let operation_id = Uuid::new_v4().to_string();
                let now = Instant::now();
                self.operations
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(
                        operation_id.clone(),
                        Operation {
                            filesystem_id: filesystem_id.unwrap_or("local").to_string(),
                            path: path.to_string(),
                            started: now,
                            last_progress: progress,
                            last_activity_marker: activity_marker,
                            last_activity_at: now,
                        },
                    );
                Ok(materializing(operation_id, progress, 0))
            }
        }
    }

    pub fn status(
        &self,
        filesystem: &Filesystem,
        operation_id: &str,
    ) -> Result<ContentPreparation, NativeError> {
        let (filesystem_id, path) = {
            let operations = self
                .operations
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let operation = operations.get(operation_id).ok_or_else(|| {
                NativeError::new(
                    "ECONTENT_OPERATION_NOT_FOUND",
                    "This content preparation is no longer active",
                )
            })?;
            (operation.filesystem_id.clone(), operation.path.clone())
        };

        let inspection = match prepare_once(filesystem, Some(&filesystem_id), &path, false) {
            Ok(inspection) => inspection,
            Err(error) => {
                let elapsed = self.remove_elapsed(operation_id).unwrap_or_default();
                eprintln!(
                    "[content-availability] operation_id={operation_id:?} path={path:?} state=FAILED elapsed_ms={} error={error:?}",
                    elapsed.as_millis()
                );
                return Err(error);
            }
        };

        match inspection {
            PrepareOnce::Ready(_) => {
                let elapsed = self.remove_elapsed(operation_id).unwrap_or_default();
                eprintln!(
                    "[content-availability] operation_id={operation_id:?} path={path:?} state=READY elapsed_ms={}",
                    elapsed.as_millis()
                );
                Ok(ready(elapsed.as_millis()))
            }
            PrepareOnce::Materializing {
                progress,
                activity_marker,
                ..
            } => {
                let mut operations = self
                    .operations
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let operation = operations.get_mut(operation_id).ok_or_else(|| {
                    NativeError::new(
                        "ECONTENT_OPERATION_NOT_FOUND",
                        "This content preparation is no longer active",
                    )
                })?;
                let now = Instant::now();
                if progress
                    .zip(operation.last_progress)
                    .is_some_and(|(current, previous)| current > previous + 0.000_1)
                    || (progress.is_some() && operation.last_progress.is_none())
                    || activity_marker
                        .zip(operation.last_activity_marker)
                        .is_some_and(|(current, previous)| current > previous)
                    || (activity_marker.is_some() && operation.last_activity_marker.is_none())
                {
                    operation.last_progress = progress;
                    operation.last_activity_marker = activity_marker;
                    operation.last_activity_at = now;
                }

                if now.duration_since(operation.last_activity_at) >= STALLED_ACTIVITY_INTERVAL {
                    let elapsed_ms = now.duration_since(operation.started).as_millis();
                    operations.remove(operation_id);
                    eprintln!(
                        "[content-availability] operation_id={operation_id:?} path={path:?} state=FAILED elapsed_ms={elapsed_ms} progress={progress:?} activity_marker={activity_marker:?} error=ECLOUD_DOWNLOAD_STALLED"
                    );
                    return Err(NativeError::new(
                        "ECLOUD_DOWNLOAD_STALLED",
                        "The cloud download stopped making progress. Check your connection and try again.",
                    )
                    .with_path(path)
                    .with_native_error(format!(
                        "progress={progress:?} activity_marker={activity_marker:?} stalled_ms={}",
                        STALLED_ACTIVITY_INTERVAL.as_millis()
                    )));
                }

                Ok(materializing(
                    operation_id.to_string(),
                    progress,
                    now.duration_since(operation.started).as_millis(),
                ))
            }
        }
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let removed = self
            .operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(operation_id);
        if let Some(operation) = &removed {
            eprintln!(
                "[content-availability] operation_id={operation_id:?} path={:?} state=CANCELLED elapsed_ms={}",
                operation.path,
                operation.started.elapsed().as_millis()
            );
        }
        removed.is_some()
    }

    fn remove_elapsed(&self, operation_id: &str) -> Option<Duration> {
        self.operations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(operation_id)
            .map(|operation| operation.started.elapsed())
    }
}

fn ready(elapsed_ms: u128) -> ContentPreparation {
    ContentPreparation {
        state: AvailabilityState::Ready,
        operation_id: None,
        progress: Some(1.0),
        user_message: "File is ready".to_string(),
        elapsed_ms,
    }
}

fn materializing(
    operation_id: String,
    progress: Option<f64>,
    elapsed_ms: u128,
) -> ContentPreparation {
    ContentPreparation {
        state: AvailabilityState::Materializing,
        operation_id: Some(operation_id),
        progress,
        user_message: "Preparing file…".to_string(),
        elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::ContentManager;
    use crate::filesystem::Filesystem;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn ready_local_content_does_not_create_an_operation() {
        let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("vesperwind-content-{}-{id}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("local file.txt");
        fs::write(&file, "ready").unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let result = ContentManager::new()
            .prepare(&filesystem, Some("local"), &file.to_string_lossy())
            .unwrap();
        assert_eq!(
            result.state,
            crate::filesystem::availability::AvailabilityState::Ready
        );
        assert!(result.operation_id.is_none());
        let _ = fs::remove_dir_all(root);
    }
}
