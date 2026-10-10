use super::{failure, success};
use crate::{
    error::NativeError,
    filesystem::{self, availability::require_content_ready, operations::OperationRequest},
    AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, State};

const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesPayload {
    filesystem_id: String,
    path: String,
    update: Option<filesystem::properties::PermissionUpdate>,
}
#[tauri::command]
pub async fn filesystem_properties(
    state: State<'_, AppState>,
    payload: PropertiesPayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            if payload.filesystem_id == "local" {
                filesystem::properties::read(&filesystem, &payload.path)
            } else {
                remote.properties(&payload.filesystem_id, &payload.path)
            }
        })
        .await
        {
            Ok(Ok(properties)) => success("properties", properties),
            Ok(Err(e)) => failure(e),
            Err(e) => failure(NativeError::new("EPROPERTIES", e.to_string())),
        },
    )
}
#[tauri::command]
pub async fn filesystem_update_properties(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: PropertiesPayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    Ok(match tauri::async_runtime::spawn_blocking(move || {
        let update = payload.update.ok_or_else(|| NativeError::new("EINVAL", "A permissions update is required"))?;
        let result = if payload.filesystem_id == "local" { filesystem::properties::update(&filesystem, &payload.path, &update) }
            else { remote.update_properties(&payload.filesystem_id, &payload.path, &update) };
        // Also invalidate on partial mutation (e.g. chown succeeded, chmod failed).
        let _ = app.emit("filesystem:changed", json!({"providerId": payload.filesystem_id,
            "directoryPath": std::path::Path::new(&payload.path).parent().map(|p| p.to_string_lossy()), "kind": "metadata"}));
        result
    }).await {
        Ok(Ok(properties)) => success("properties", properties), Ok(Err(e)) => failure(e),
        Err(e) => failure(NativeError::new("EPROPERTIES", e.to_string())),
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizePayload {
    filesystem_id: String,
    path: String,
    job_id: String,
}
#[tauri::command]
pub fn filesystem_calculate_size(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: SizePayload,
) -> Value {
    let jobs = Arc::clone(&state.operation_jobs);
    let cancelled = jobs.register(&payload.job_id);
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = filesystem::size::calculate(
            &filesystem,
            &remote,
            &payload.filesystem_id,
            &payload.path,
            &cancelled,
            |progress| {
                let _ = app.emit(
                    "filesystem:size-progress",
                    json!({"jobId": payload.job_id, "progress": progress, "done": false}),
                );
            },
        );
        let event = match result {
            Ok(progress) => json!({"jobId": payload.job_id, "progress": progress, "done": true}),
            Err(error) => json!({"jobId": payload.job_id, "error": error, "done": true}),
        };
        let _ = app.emit("filesystem:size-progress", event);
        jobs.finish(&payload.job_id);
    });
    json!({"ok": true})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeCancelPayload {
    job_id: String,
}
#[tauri::command]
pub fn filesystem_calculate_size_cancel(
    state: State<'_, AppState>,
    payload: SizeCancelPayload,
) -> Value {
    state.operation_jobs.cancel(&payload.job_id);
    json!({"ok": true})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemRootPayload {
    filesystem_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemPathPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
}

#[tauri::command]
pub async fn filesystem_resolve_location(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: FilesystemPathPayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    let provider = payload.filesystem_id.unwrap_or_else(|| "local".into());
    let path = payload.path.unwrap_or_default();
    #[cfg(not(windows))]
    let owner: isize = 0;
    #[cfg(windows)]
    let owner = {
        use tauri::Manager;
        app.get_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .unwrap_or(0)
    };
    let _ = app;
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let mut resolved = if provider == "local" {
                filesystem::network::connect_if_network(&path, owner)?
            } else {
                remote.resolve_path(&provider, &path)?
            };
            if provider == "local" {
                if !filesystem.is_computer_root(&resolved) {
                    let logical = filesystem::paths::resolve_inside_root(&filesystem, &resolved)?;
                    let physical =
                        filesystem::paths::verify_existing_inside_root(&filesystem, &logical)?;
                    if !physical.is_dir() {
                        return Err(NativeError::new("ENOTDIR", "This path is not a folder"));
                    }
                    resolved = logical.to_string_lossy().into_owned();
                }
            } else {
                remote.list(&provider, &resolved)?;
            }
            Ok(json!({"ok":true,"location":{"providerId":provider,"path":resolved}}))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EFILESYSTEM", error.to_string())),
        },
    )
}

#[tauri::command]
pub fn filesystem_watch(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: FilesystemPathPayload,
) -> Value {
    let result = (|| {
        filesystem::Filesystem::require_local(payload.filesystem_id.as_deref())?;
        state.directory_watches.watch(
            &state.filesystem,
            app,
            payload.path.as_deref().unwrap_or_default(),
        )?;
        Ok::<_, NativeError>(json!({"ok": true}))
    })();
    result.unwrap_or_else(failure)
}

#[tauri::command]
pub fn filesystem_unwatch(state: State<'_, AppState>, payload: FilesystemPathPayload) -> Value {
    if let Err(error) = filesystem::Filesystem::require_local(payload.filesystem_id.as_deref()) {
        return failure(error);
    }
    state.directory_watches.unwatch(
        &state.filesystem,
        payload.path.as_deref().unwrap_or_default(),
    );
    json!({"ok": true})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
    content: Option<String>,
}

#[tauri::command]
pub fn filesystem_root(state: State<'_, AppState>, payload: FilesystemRootPayload) -> Value {
    let result = (|| {
        if let Some(provider) = payload
            .filesystem_id
            .as_deref()
            .filter(|value| *value != "local")
        {
            let (root, initial, home) = state.remote.root(provider)?;
            return Ok::<_, NativeError>(
                json!({ "ok": true, "root": root, "initial": initial, "homePath": home }),
            );
        }
        filesystem::Filesystem::require_local(payload.filesystem_id.as_deref())?;
        Ok::<_, NativeError>(json!({
            "ok": true,
            "root": state.filesystem.root_entry()?,
            "initial": state.filesystem.initial_entry()?,
            "homePath": state.filesystem.home().to_string_lossy(),
        }))
    })();
    result.unwrap_or_else(failure)
}

/// Opt-in timing for listing and lazy cloud status (`VESPERWIND_LISTING_TRACE=1`).
fn listing_trace() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("VESPERWIND_LISTING_TRACE").is_some_and(|v| v == "1"))
}

#[tauri::command]
pub async fn filesystem_list(
    state: State<'_, AppState>,
    payload: FilesystemPathPayload,
) -> Result<Value, String> {
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    let path = payload.path.unwrap_or_default();
    // Large directory enumeration runs off the UI thread. Local listings carry
    // no cloud status; `filesystem_cloud_status` adds it after rendering.
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(provider) = payload
            .filesystem_id
            .as_deref()
            .filter(|value| *value != "local")
        {
            let entries = remote.list(provider, &path)?;
            return Ok::<_, NativeError>(json!({ "ok": true, "path": path, "entries": entries }));
        }
        filesystem::Filesystem::require_local(payload.filesystem_id.as_deref())?;
        let started = std::time::Instant::now();
        let entries = filesystem.list_directory(&path)?;
        let listed = started.elapsed();
        let value = json!({ "ok": true, "path": path, "entries": entries });
        if listing_trace() {
            eprintln!(
                "[listing] path={path:?} entries={} list_ms={:.1} serialize_ms={:.1}",
                entries.len(),
                listed.as_secs_f64() * 1000.0,
                (started.elapsed() - listed).as_secs_f64() * 1000.0
            );
        }
        Ok::<_, NativeError>(value)
    })
    .await;
    Ok(match result {
        Ok(result) => result.unwrap_or_else(failure),
        Err(error) => failure(NativeError::new("EFILESYSTEM", error.to_string())),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusPayload {
    request_id: String,
    filesystem_id: Option<String>,
    directory_path: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusCancelPayload {
    request_id: String,
}

/// Passive iCloud/OneDrive status for one batch of a listed local folder.
/// Batches are cancellable between entries and limited in concurrency.
#[tauri::command]
pub async fn filesystem_cloud_status(
    state: State<'_, AppState>,
    payload: CloudStatusPayload,
) -> Result<Value, String> {
    if payload.request_id.is_empty() {
        return Ok(failure(NativeError::new(
            "EINVAL",
            "A request id is required",
        )));
    }
    if let Err(error) = filesystem::Filesystem::require_local(payload.filesystem_id.as_deref()) {
        return Ok(failure(error));
    }
    let filesystem = Arc::clone(&state.filesystem);
    let jobs = Arc::clone(&state.operation_jobs);
    #[cfg(target_os = "windows")]
    let content = Arc::clone(&state.content);
    let cancelled = jobs.register(&payload.request_id);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result = filesystem::cloud_status::inspect_limited(
            &filesystem,
            &payload.directory_path,
            &payload.paths,
            &cancelled,
        );
        jobs.finish(&payload.request_id);
        if listing_trace() {
            eprintln!(
                "[cloud-status] directory={:?} entries={} ms={:.1} result={}",
                payload.directory_path,
                payload.paths.len(),
                started.elapsed().as_secs_f64() * 1000.0,
                match &result {
                    Ok(batch) if batch.complete => "complete".to_string(),
                    Ok(_) => "ok".to_string(),
                    Err(error) => error.code.clone(),
                }
            );
        }
        result
    })
    .await;
    Ok(match result {
        Ok(Ok(batch)) => {
            #[cfg(target_os = "windows")]
            let batch = {
                let mut batch = batch;
                content.annotate_cloud_status(&mut batch.statuses);
                batch
            };
            json!({ "ok": true, "statuses": batch.statuses, "complete": batch.complete })
        }
        Ok(Err(error)) => failure(error),
        Err(error) => failure(NativeError::new("EFILESYSTEM", error.to_string())),
    })
}

#[tauri::command]
pub fn filesystem_cloud_status_cancel(
    state: State<'_, AppState>,
    payload: CloudStatusCancelPayload,
) -> Value {
    state.operation_jobs.cancel(&payload.request_id);
    json!({"ok": true})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPayload {
    search_id: String,
    filesystem_id: Option<String>,
    base_path: String,
    query: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    max_results: Option<usize>,
    hidden_name_suffixes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCancelPayload {
    search_id: String,
}

#[tauri::command]
pub fn filesystem_search(
    state: State<'_, AppState>,
    app: AppHandle,
    payload: SearchPayload,
) -> Value {
    if payload.search_id.is_empty() || payload.query.trim().is_empty() {
        return failure(NativeError::new("EINVAL", "Invalid search request"));
    }
    let search_id = payload.search_id.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .search_jobs
        .lock()
        .unwrap()
        .insert(search_id.clone(), Arc::clone(&cancelled));
    let jobs = Arc::clone(&state.search_jobs);
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    std::thread::spawn(move || {
        let result = filesystem::search::search(
            &filesystem,
            &remote,
            payload.filesystem_id.as_deref().unwrap_or("local"),
            &payload.base_path,
            &payload.query,
            payload.kind.as_deref().unwrap_or("all"),
            payload
                .max_results
                .unwrap_or(filesystem::search::MAX_RESULTS),
            &payload.hidden_name_suffixes.unwrap_or_default(),
            &cancelled,
            |entries| {
                if !cancelled.load(Ordering::Acquire) {
                    let _ = app.emit(
                        "filesystem:search-results",
                        json!({"searchId":search_id,"entries":entries}),
                    );
                }
            },
        );
        let event = match result {
            Ok(outcome) => {
                json!({"searchId":search_id,"done":true,"count":outcome.count,"limited":outcome.limited,"cancelled":outcome.cancelled})
            }
            Err(error) => json!({"searchId":search_id,"done":true,"error":error}),
        };
        let _ = app.emit("filesystem:search-results", event);
        jobs.lock().unwrap().remove(&search_id);
    });
    json!({"ok":true,"searchId":payload.search_id})
}

#[tauri::command]
pub fn filesystem_search_cancel(state: State<'_, AppState>, payload: SearchCancelPayload) -> Value {
    if let Some(cancelled) = state.search_jobs.lock().unwrap().get(&payload.search_id) {
        cancelled.store(true, Ordering::Release);
    }
    json!({"ok":true})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemTextReadPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
    max_bytes: Option<u64>,
    #[serde(default)]
    strict_text: bool,
}

#[tauri::command]
pub async fn filesystem_read_text(
    state: State<'_, AppState>,
    payload: FilesystemTextReadPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    if let Some(provider) = payload
        .filesystem_id
        .as_deref()
        .filter(|value| *value != "local")
    {
        return Ok(
            match state
                .remote
                .read_text(provider, &path, payload.max_bytes, payload.strict_text)
            {
                Ok((content, modified)) => {
                    json!({"ok":true,"content":content,"modifiedAt":modified})
                }
                Err(error) => failure(error),
            },
        );
    }
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    let requested = path.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let metadata = fs::metadata(&real).map_err(|error| text_error(&error, &requested))?;
            validate_text_metadata(&metadata)?;
            let limit = filesystem::text::read_limit(payload.max_bytes);
            if metadata.len() > limit {
                return Err(NativeError::new(
                    "EFILE_TOO_LARGE",
                    "Text file exceeds the read limit",
                ));
            }
            let file = fs::File::open(&real).map_err(|error| text_error(&error, &requested))?;
            let content = filesystem::text::read_bounded(file, limit, payload.strict_text)?;
            Ok::<_, NativeError>(json!({
                "ok": true,
                "content": content,
                "modifiedAt": metadata.modified().ok().map(filesystem::format_time),
            }))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to read this file")
                    .with_path(path)
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

#[tauri::command]
pub async fn filesystem_write_text(
    state: State<'_, AppState>,
    payload: WriteTextPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    let content = match payload.content {
        Some(content) => content,
        None => return Ok(failure(NativeError::new("EINVAL", "Invalid file contents"))),
    };
    if let Some(provider) = payload
        .filesystem_id
        .as_deref()
        .filter(|value| *value != "local")
    {
        return Ok(match state.remote.write_text(provider, &path, &content) {
            Ok(modified) => json!({"ok":true,"modifiedAt":modified}),
            Err(error) => failure(error),
        });
    }
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Ok(failure(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 10 MB cannot be opened in the editor",
        )));
    }
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    let requested = path.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            validate_text_metadata(
                &fs::metadata(&real).map_err(|error| text_error(&error, &requested))?,
            )?;
            fs::write(&real, content).map_err(|error| text_error(&error, &requested))?;
            let metadata = fs::metadata(&real).map_err(|error| text_error(&error, &requested))?;
            Ok::<_, NativeError>(json!({
                "ok": true,
                "modifiedAt": metadata.modified().ok().map(filesystem::format_time),
            }))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(
                NativeError::new("EFILE_IO", "Unable to save this file")
                    .with_path(path)
                    .with_native_error(error.to_string()),
            ),
        },
    )
}

const MAX_BINARY_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBinaryPayload {
    filesystem_id: Option<String>,
    path: Option<String>,
    base64: Option<String>,
}

#[tauri::command]
pub async fn filesystem_read_binary(
    state: State<'_, AppState>,
    payload: FilesystemPathPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    if let Some(provider) = payload.filesystem_id.as_deref().filter(|id| *id != "local") {
        return Ok(match state.remote.read_binary(provider, &path) {
            Ok((bytes, modified)) => {
                json!({"ok":true,"base64":STANDARD.encode(bytes),"modifiedAt":modified})
            }
            Err(error) => failure(error),
        });
    }
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let metadata = fs::metadata(&real)
                .map_err(|e| NativeError::from_io(&e, "Unable to read this file"))?;
            validate_binary_metadata(&metadata)?;
            let bytes = fs::read(&real)
                .map_err(|e| NativeError::from_io(&e, "Unable to read this file"))?;
            Ok::<_, NativeError>(json!({"ok":true,"base64":STANDARD.encode(bytes),
            "modifiedAt":metadata.modified().ok().map(filesystem::format_time)}))
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EFILE_IO", error.to_string())),
        },
    )
}

#[tauri::command]
pub async fn filesystem_write_binary(
    state: State<'_, AppState>,
    payload: WriteBinaryPayload,
) -> Result<Value, String> {
    let path = payload.path.unwrap_or_default();
    let encoded = match payload.base64 {
        Some(value) => value,
        None => {
            return Ok(failure(NativeError::new(
                "EINVAL",
                "Invalid binary contents",
            )))
        }
    };
    if encoded.len() as u64 > ((MAX_BINARY_FILE_BYTES + 2) / 3) * 4 {
        return Ok(failure(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 32 MB cannot be saved",
        )));
    }
    let bytes = match STANDARD.decode(encoded.as_bytes()) {
        Ok(bytes) if bytes.len() as u64 <= MAX_BINARY_FILE_BYTES => bytes,
        _ => {
            return Ok(failure(NativeError::new(
                "EINVAL",
                "Invalid binary contents",
            )))
        }
    };
    if let Some(provider) = payload.filesystem_id.as_deref().filter(|id| *id != "local") {
        return Ok(match state.remote.write_binary(provider, &path, &bytes) {
            Ok(modified) => json!({"ok":true,"modifiedAt":modified}),
            Err(error) => failure(error),
        });
    }
    let real =
        match require_content_ready(&state.filesystem, payload.filesystem_id.as_deref(), &path) {
            Ok(real) => real,
            Err(error) => return Ok(failure(error)),
        };
    Ok(match tauri::async_runtime::spawn_blocking(move || {
        validate_binary_metadata(&fs::metadata(&real).map_err(|e| NativeError::from_io(&e, "Unable to save this file"))?)?;
        fs::write(&real, bytes).map_err(|e| NativeError::from_io(&e, "Unable to save this file"))?;
        let metadata = fs::metadata(&real).map_err(|e| NativeError::from_io(&e, "Unable to save this file"))?;
        Ok::<_, NativeError>(json!({"ok":true,"modifiedAt":metadata.modified().ok().map(filesystem::format_time)}))
    }).await {
        Ok(Ok(value)) => value, Ok(Err(error)) => failure(error),
        Err(error) => failure(NativeError::new("EFILE_IO", error.to_string())),
    })
}

fn validate_binary_metadata(metadata: &fs::Metadata) -> Result<(), NativeError> {
    if !metadata.is_file() {
        return Err(NativeError::new("EISDIR", "This item is not a file"));
    }
    if metadata.len() > MAX_BINARY_FILE_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 32 MB cannot be opened",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn filesystem_operate(
    state: State<'_, AppState>,
    payload: OperationRequest,
) -> Result<Value, String> {
    let jobs = Arc::clone(&state.operation_jobs);
    let filesystem = Arc::clone(&state.filesystem);
    let remote = state.remote.clone();
    // Register before spawning so cancellation can also stop a queued job.
    let id = payload
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancelled = jobs.register(&id);
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            let result = filesystem::jobs::execute(&filesystem, &remote, payload, &cancelled);
            jobs.finish(&id);
            result
        })
        .await
        {
            Ok(Ok(result)) => success("result", result),
            Ok(Err(error)) => failure(error),
            Err(error) => failure(NativeError::new("EWORKER_LOST", error.to_string())),
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCancelPayload {
    operation_id: String,
}

#[tauri::command]
pub fn filesystem_operation_cancel(
    state: State<'_, AppState>,
    payload: OperationCancelPayload,
) -> Value {
    state.operation_jobs.cancel(&payload.operation_id);
    json!({"ok":true})
}

fn validate_text_metadata(metadata: &fs::Metadata) -> Result<(), NativeError> {
    if !metadata.is_file() {
        return Err(NativeError::new("EISDIR", "This item is not a text file"));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Files larger than 10 MB cannot be opened in the editor",
        ));
    }
    Ok(())
}

fn text_error(error: &std::io::Error, path: &str) -> NativeError {
    let mut result =
        NativeError::from_io(error, "Unable to read or save this file").with_path(path);
    result.message = match result.code.as_str() {
        "EACCES" => "Permission denied",
        "ENOENT" => "File no longer exists",
        "EISDIR" => "This item is not a text file",
        _ => "Unable to read or save this file",
    }
    .to_string();
    result
}

#[cfg(test)]
mod binary_tests {
    use super::*;
    #[test]
    fn binary_file_validation_rejects_directories_and_oversized_files() {
        let root = std::env::temp_dir().join(format!("vesperwind-binary-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("Отчёт workbook.xlsx");
        fs::write(&file, [0, 255, 0, 42]).unwrap();
        assert!(validate_binary_metadata(&fs::metadata(&file).unwrap()).is_ok());
        assert_eq!(
            validate_binary_metadata(&fs::metadata(&root).unwrap())
                .unwrap_err()
                .code,
            "EISDIR"
        );
        let handle = fs::OpenOptions::new().write(true).open(&file).unwrap();
        handle.set_len(MAX_BINARY_FILE_BYTES + 1).unwrap();
        assert_eq!(
            validate_binary_metadata(&fs::metadata(&file).unwrap())
                .unwrap_err()
                .code,
            "EFILE_TOO_LARGE"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
