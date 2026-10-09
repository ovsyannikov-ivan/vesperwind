//! Desktop shell integration: the native file clipboard, external drag and
//! drop and disk image mounting. Platform code lives in `macos` / `windows`;
//! this module owns the provider-aware model and the capability report the
//! frontend uses (it never sniffs the user agent for these features).
pub mod clipboard;
pub mod disk_image;
// Finder Paste of remote items; other platforms stream instead.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod staging;
pub mod transfer;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

use crate::error::NativeError;
use clipboard::{ClipboardFileRef, ClipboardManager, ClipboardOperation, ClipboardSnapshot};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicBool, Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use transfer::ProviderFiles;

/// Items dragged out of Vesperwind use the same `{ providerId, path }` model.
pub type DragItem = ClipboardFileRef;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn emit(event: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Cut/Copy/Paste through the system clipboard (Finder/Explorer).
    pub native_file_clipboard: bool,
    /// Finder/Explorer files dropped onto the window resolve to real paths.
    pub external_file_drop: bool,
    /// Items can be dragged out to Finder/Explorer.
    pub external_drag_out: bool,
    pub mount_disk_image: bool,
    pub disk_image_extensions: Vec<&'static str>,
}

pub fn capabilities() -> Capabilities {
    let desktop = cfg!(any(target_os = "macos", target_os = "windows"));
    let platform = disk_image::ImagePlatform::current();
    Capabilities {
        native_file_clipboard: desktop,
        external_file_drop: desktop,
        external_drag_out: desktop,
        mount_disk_image: platform != disk_image::ImagePlatform::Unsupported,
        disk_image_extensions: platform.extensions().to_vec(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteResult {
    pub token: String,
    pub operation: ClipboardOperation,
    pub items: Vec<ClipboardFileRef>,
    /// True when Finder/Explorer can paste the items.
    pub system_clipboard: bool,
    /// macOS: remote items are being staged for Finder Paste.
    pub staging: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropRequest {
    /// Windows: id sent with the File objects through WebView2.
    pub id: Option<String>,
    pub expected_count: usize,
    #[serde(default)]
    pub names: Vec<String>,
}

#[derive(Default)]
pub struct ShellIntegration {
    pub clipboard: ClipboardManager,
    files: OnceLock<ProviderFiles>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    staging: OnceLock<staging::Staging>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    staging_job: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn not_desktop() -> NativeError {
    NativeError::new(
        "ENOTSUPPORTED",
        "This desktop integration is not available on this platform",
    )
}

impl ShellIntegration {
    pub fn setup(&self, app: &AppHandle, remote: crate::remote::RemoteProviders) {
        let _ = APP.set(app.clone());
        let _ = self.files.set(ProviderFiles { remote });
        #[cfg(target_os = "macos")]
        {
            use tauri::Manager;
            if let Ok(cache) = app.path().app_cache_dir() {
                let staging = staging::Staging::new(cache.join("clipboard-staging"));
                let _ = self.staging.set(staging.clone());
                // Startup cleanup keeps only data the pasteboard still references.
                let app = app.clone();
                std::thread::spawn(move || {
                    staging.cleanup(macos::clipboard_token(&app).as_deref())
                });
            }
        }
        #[cfg(target_os = "windows")]
        windows::setup(app);
    }

    fn files(&self) -> Result<ProviderFiles, NativeError> {
        self.files
            .get()
            .cloned()
            .ok_or_else(|| NativeError::new("ENATIVE", "Desktop integration is not ready"))
    }

    pub fn write_clipboard(
        &self,
        app: &AppHandle,
        operation: ClipboardOperation,
        items: Vec<ClipboardFileRef>,
    ) -> Result<ClipboardWriteResult, NativeError> {
        let payload = self.clipboard.set(operation, items)?;
        let mut result = ClipboardWriteResult {
            token: payload.token.clone(),
            operation,
            items: payload.items.clone(),
            system_clipboard: false,
            staging: false,
        };
        #[cfg(target_os = "macos")]
        {
            self.cancel_staging();
            let local: Vec<_> = payload
                .items
                .iter()
                .filter(|item| item.is_local())
                .map(|item| std::path::PathBuf::from(&item.path))
                .collect();
            let remote = local.len() != payload.items.len();
            let published = if remote { vec![] } else { local };
            if let Err(error) = macos::write_clipboard(app, payload.clone(), published, None) {
                self.clipboard.clear_token(&payload.token);
                return Err(error);
            }
            result.system_clipboard = !remote;
            if remote {
                result.staging = self.start_staging(app, payload);
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Err(error) = windows::write_clipboard(payload.clone(), self.files()?) {
                self.clipboard.clear_token(&payload.token);
                return Err(error);
            }
            result.system_clipboard = true;
        }
        let _ = app;
        Ok(result)
    }

    #[cfg(target_os = "macos")]
    fn cancel_staging(&self) {
        if let Some((_, cancel)) = self
            .staging_job
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .take()
        {
            cancel.store(true, Ordering::Release);
        }
    }

    /// Finder Paste needs real files. Stream remote items into the managed
    /// staging area in the background and then publish file URLs, if the
    /// pasteboard still holds this clipboard.
    #[cfg(target_os = "macos")]
    fn start_staging(&self, app: &AppHandle, payload: clipboard::ClipboardPayload) -> bool {
        let (Some(staging), Ok(files)) = (self.staging.get().cloned(), self.files()) else {
            return false;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        *self.staging_job.lock().unwrap_or_else(|v| v.into_inner()) =
            Some((payload.token.clone(), Arc::clone(&cancel)));
        let app = app.clone();
        std::thread::spawn(move || {
            let token = payload.token.clone();
            let remote: Vec<(String, String)> = payload
                .items
                .iter()
                .filter(|item| !item.is_local())
                .map(|item| (item.provider_id.clone(), item.path.clone()))
                .collect();
            let report = |state: &str, extra: serde_json::Value| {
                let mut event = serde_json::json!({ "token": token, "state": state });
                if let (Some(target), serde_json::Value::Object(extra)) =
                    (event.as_object_mut(), extra)
                {
                    target.extend(extra);
                }
                emit("clipboard:staging", event);
            };
            let total = match staging::Staging::measure(&files, &remote, &cancel) {
                Ok(total) if total > staging::MAX_STAGED_BYTES => {
                    report(
                        "skipped",
                        serde_json::json!({ "total": total, "error": NativeError::new(
                        "ESTAGING_TOO_LARGE",
                        "The remote selection is too large to prepare for Finder Paste. Drag the items to Finder instead; Vesperwind Paste still works.",
                    ) }),
                    );
                    return;
                }
                Ok(total) => total,
                Err(error) => {
                    if error.code != "ECANCELLED" {
                        report("failed", serde_json::json!({ "error": error }));
                    }
                    return;
                }
            };
            report("started", serde_json::json!({ "total": total, "bytes": 0 }));
            let mut bytes = 0u64;
            let mut last = std::time::Instant::now();
            let staged = staging.stage(&files, &token, &remote, &cancel, &mut |chunk| {
                bytes += chunk;
                if last.elapsed() >= std::time::Duration::from_millis(250) {
                    last = std::time::Instant::now();
                    report(
                        "progress",
                        serde_json::json!({ "total": total, "bytes": bytes }),
                    );
                }
            });
            let staged = match staged {
                Ok(staged) => staged,
                Err(error) => {
                    if error.code != "ECANCELLED" {
                        report("failed", serde_json::json!({ "error": error }));
                    }
                    return;
                }
            };
            let mut staged = staged.into_iter();
            let files: Vec<_> = payload
                .items
                .iter()
                .filter_map(|item| {
                    if item.is_local() {
                        Some(std::path::PathBuf::from(&item.path))
                    } else {
                        staged.next()
                    }
                })
                .collect();
            match macos::write_clipboard(&app, payload.clone(), files, Some(token.clone())) {
                Ok(true) => {
                    report(
                        "ready",
                        serde_json::json!({ "total": total, "bytes": bytes }),
                    );
                    staging.cleanup(Some(&token));
                }
                // The user copied something else meanwhile: drop the data.
                Ok(false) => staging.cleanup(macos::clipboard_token(&app).as_deref()),
                Err(error) => report("failed", serde_json::json!({ "error": error })),
            }
        });
        true
    }

    pub fn read_clipboard(
        &self,
        app: &AppHandle,
    ) -> Result<Option<ClipboardSnapshot>, NativeError> {
        #[cfg(target_os = "macos")]
        {
            let system = macos::read_clipboard(app)?;
            let referenced = system.payload.as_ref().map(|payload| payload.token.clone());
            let snapshot = self.clipboard.resolve(Some(system));
            let mut job = self.staging_job.lock().unwrap_or_else(|v| v.into_inner());
            if job
                .as_ref()
                .is_some_and(|(token, _)| Some(token) != referenced.as_ref())
            {
                if let Some((_, cancel)) = job.take() {
                    cancel.store(true, Ordering::Release);
                }
                if let Some(staging) = self.staging.get().cloned() {
                    std::thread::spawn(move || staging.cleanup(referenced.as_deref()));
                }
            }
            Ok(snapshot)
        }
        #[cfg(target_os = "windows")]
        {
            let _ = app;
            Ok(self.clipboard.resolve(Some(windows::read_clipboard()?)))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = app;
            Ok(self.clipboard.resolve(None))
        }
    }

    /// After a successful Paste: a Cut is used up and the system clipboard,
    /// which would otherwise reference moved files, is cleared.
    pub fn consume(
        &self,
        app: &AppHandle,
        token: Option<String>,
        operation: ClipboardOperation,
    ) -> Result<(), NativeError> {
        if !self.clipboard.consume(token.as_deref(), operation) {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        match token {
            Some(token) => macos::clear_clipboard(app, &token),
            // A Cut written by another Vesperwind instance.
            None => {
                if let Ok(system) = macos::read_clipboard(app) {
                    if let Some(payload) = system
                        .payload
                        .filter(|p| p.operation == ClipboardOperation::Cut)
                    {
                        macos::clear_clipboard(app, &payload.token);
                    }
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            let _ = app;
            windows::finish_paste(token)?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = (app, token);
        Ok(())
    }

    pub fn read_drop(
        &self,
        app: &AppHandle,
        request: DropRequest,
    ) -> Result<Vec<ClipboardFileRef>, NativeError> {
        #[cfg(target_os = "macos")]
        let items = {
            let _ = &request.id;
            macos::read_drop(app)?
        };
        #[cfg(target_os = "windows")]
        let items = {
            let _ = app;
            windows::take_drop(request.id.as_deref().unwrap_or_default())?
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let items: Vec<ClipboardFileRef> = {
            let _ = app;
            return Err(not_desktop());
        };
        verify_drop(items, &request)
    }

    pub fn start_drag(&self, app: &AppHandle, items: Vec<DragItem>) -> Result<(), NativeError> {
        let items = clipboard::normalize_items(items)?;
        #[cfg(target_os = "macos")]
        return macos::start_drag(app, items, self.files()?);
        #[cfg(target_os = "windows")]
        return windows::start_drag(app, items, self.files()?);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, items);
            Err(not_desktop())
        }
    }

    pub fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        self.cancel_staging();
        #[cfg(target_os = "windows")]
        windows::shutdown();
    }
}

/// The page saw `expected_count` files with `names`; the native side must
/// report the same drag, otherwise an older pasteboard could be pasted.
pub fn verify_drop(
    items: Vec<ClipboardFileRef>,
    request: &DropRequest,
) -> Result<Vec<ClipboardFileRef>, NativeError> {
    let stale = || {
        NativeError::new(
            "EDROP_UNAVAILABLE",
            "The dropped items could not be read. Only files and folders from Finder or Explorer can be dropped.",
        )
    };
    if items.is_empty() || items.len() != request.expected_count {
        return Err(stale());
    }
    if !request.names.is_empty() {
        let mut expected = request.names.clone();
        let mut actual: Vec<String> = items.iter().map(|item| item.name.clone()).collect();
        expected.sort();
        actual.sort();
        if expected != actual {
            return Err(stale());
        }
    }
    clipboard::normalize_items(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(name: &str) -> ClipboardFileRef {
        ClipboardFileRef {
            provider_id: "local".into(),
            path: format!("/Users/me/{name}"),
            name: name.into(),
            is_directory: false,
        }
    }

    #[test]
    fn capabilities_follow_the_platform() {
        let report = capabilities();
        let desktop = cfg!(any(target_os = "macos", target_os = "windows"));
        assert_eq!(report.native_file_clipboard, desktop);
        assert_eq!(report.external_drag_out, desktop);
        if cfg!(target_os = "macos") {
            assert_eq!(report.disk_image_extensions, ["dmg", "iso"]);
        }
        if cfg!(target_os = "windows") {
            assert_eq!(report.disk_image_extensions, ["iso"]);
        }
        let json = serde_json::to_value(report).unwrap();
        assert!(json.get("nativeFileClipboard").is_some());
        assert!(json.get("mountDiskImage").is_some());
    }

    #[test]
    fn drop_verification_rejects_a_stale_drag_pasteboard() {
        let request = |count, names: &[&str]| DropRequest {
            id: None,
            expected_count: count,
            names: names.iter().map(|n| n.to_string()).collect(),
        };
        let items = vec![local("a.txt"), local("Папка")];
        assert_eq!(
            verify_drop(items.clone(), &request(2, &["Папка", "a.txt"]))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            verify_drop(items.clone(), &request(1, &[]))
                .unwrap_err()
                .code,
            "EDROP_UNAVAILABLE"
        );
        assert_eq!(
            verify_drop(items.clone(), &request(2, &["a.txt", "b.txt"]))
                .unwrap_err()
                .code,
            "EDROP_UNAVAILABLE"
        );
        assert_eq!(
            verify_drop(vec![], &request(0, &[])).unwrap_err().code,
            "EDROP_UNAVAILABLE"
        );
    }
}
