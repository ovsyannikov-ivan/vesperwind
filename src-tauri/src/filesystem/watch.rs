use super::{paths, Filesystem};
use crate::error::NativeError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

struct WatchRecord {
    _watcher: RecommendedWatcher,
    consumers: HashMap<String, usize>,
}

#[derive(Default)]
pub struct DirectoryWatches {
    watches: Arc<Mutex<HashMap<PathBuf, WatchRecord>>>,
}

impl DirectoryWatches {
    fn guarded_directory(
        filesystem: &Filesystem,
        requested: &str,
    ) -> Result<(PathBuf, PathBuf), NativeError> {
        let logical = paths::resolve_inside_root(filesystem, requested)?;
        let physical = paths::verify_existing_inside_root(filesystem, &logical)?;
        if !fs::metadata(&physical)
            .map_err(|error| NativeError::from_io(&error, "Unable to watch this folder"))?
            .is_dir()
        {
            return Err(NativeError::new("ENOTDIR", "This item is not a folder"));
        }
        Ok((logical, physical))
    }

    pub fn watch(
        &self,
        filesystem: &Filesystem,
        app: AppHandle,
        requested: &str,
    ) -> Result<(), NativeError> {
        let (logical, physical) = Self::guarded_directory(filesystem, requested)?;
        let logical = logical.to_string_lossy().into_owned();
        let mut watches = self.watches.lock().unwrap();
        if let Some(record) = watches.get_mut(&physical) {
            *record.consumers.entry(logical).or_default() += 1;
            return Ok(());
        }
        let records = Arc::clone(&self.watches);
        let watched_path = physical.clone();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let error = result.err().map(|error| error.to_string()).or_else(||
                fs::metadata(&watched_path).err().map(|error| error.to_string()));
            let consumers = records.lock().unwrap().get(&watched_path)
                .map(|record| record.consumers.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            for directory_path in consumers {
                let payload = json!({
                    "providerId": "local", "directoryPath": directory_path, "kind": "changed",
                    "error": error.as_ref().map(|error| json!({"code": "EWATCH", "message": error})),
                });
                if let Err(emit_error) = app.emit("filesystem:changed", payload) {
                    eprintln!("Unable to emit filesystem change: {emit_error}");
                }
            }
            if let Some(error) = error {
                eprintln!("Filesystem watcher failed for {}: {error}", watched_path.display());
                let records = Arc::clone(&records);
                let path = watched_path.clone();
                std::thread::spawn(move || { records.lock().unwrap().remove(&path); });
            }
        }).map_err(|error| NativeError::new("EWATCH", error.to_string()))?;
        watcher
            .watch(&physical, RecursiveMode::NonRecursive)
            .map_err(|error| NativeError::new("EWATCH", error.to_string()))?;
        watches.insert(
            physical,
            WatchRecord {
                _watcher: watcher,
                consumers: HashMap::from([(logical, 1)]),
            },
        );
        Ok(())
    }

    pub fn unwatch(&self, filesystem: &Filesystem, requested: &str) {
        let Ok(logical) = paths::resolve_inside_root(filesystem, requested) else {
            return;
        };
        let requested = logical.to_string_lossy();
        let mut watches = self.watches.lock().unwrap();
        watches.retain(|_, record| {
            if let Some(count) = record.consumers.get_mut(requested.as_ref()) {
                *count -= 1;
                if *count == 0 {
                    record.consumers.remove(requested.as_ref());
                }
            }
            !record.consumers.is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn guarded_watch_path_rejects_escape_and_uses_real_directory() {
        let fixture =
            std::env::temp_dir().join(format!("vesperwind-watch-{}", uuid::Uuid::new_v4()));
        let root = fixture.join("root");
        let outside = fixture.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        assert_eq!(
            DirectoryWatches::guarded_directory(&filesystem, &root.to_string_lossy())
                .unwrap()
                .1,
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            DirectoryWatches::guarded_directory(&filesystem, &outside.to_string_lossy())
                .unwrap_err()
                .code,
            "EOUTSIDE_ROOT"
        );
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn native_nonrecursive_watcher_reports_external_create() {
        let directory =
            std::env::temp_dir().join(format!("vesperwind-watch-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .unwrap();
        fs::write(directory.join("Unicode file 目录.txt"), b"created").unwrap();
        assert!(receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_ok());
        drop(watcher);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_watcher_reports_attribute_changes_without_content_writes() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("vesperwind-watch-attrs-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let file = directory.join("attributes.txt");
        fs::write(&file, b"unchanged content").unwrap();
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .unwrap();
        let mode = fs::metadata(&file).unwrap().permissions().mode();
        fs::set_permissions(&file, fs::Permissions::from_mode(mode ^ 0o100)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut observed = false;
        while let Ok(Ok(event)) =
            receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
        {
            if event.paths.contains(&file)
                && matches!(
                    event.kind,
                    notify::EventKind::Modify(notify::event::ModifyKind::Metadata(_))
                )
            {
                observed = true;
                break;
            }
        }
        drop(watcher);
        fs::remove_dir_all(directory).unwrap();
        assert!(
            observed,
            "FSEvents must report metadata-only changes for listing refresh"
        );
    }
}
