use super::failure;
use crate::{
    error::NativeError,
    filesystem::archives::{self, ArchiveRequest},
    AppState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn archive_start(state: State<'_, AppState>, app: AppHandle, payload: ArchiveRequest) -> Value {
    if let Err(error) = archives::validate(&payload) {
        return failure(error);
    }
    let mut jobs = state.archive_jobs.lock().unwrap();
    if !jobs.is_empty() {
        return failure(NativeError::new(
            "EARCHIVE_BUSY",
            "An archive operation is already running",
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.insert(payload.job_id.clone(), Arc::clone(&cancel));
    let job_id = payload.job_id.clone();
    let response_id = job_id.clone();
    let filesystem = Arc::clone(&state.filesystem);
    let jobs = Arc::clone(&state.archive_jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let result = archives::perform(&filesystem, &payload, cancel, |mut event| {
            event["jobId"] = json!(job_id);
            let _ = app.emit("archive:progress", event);
        });
        let event = match result {
            Ok(result) => json!({"jobId":job_id,"done":true,"result":result}),
            Err(error) => json!({"jobId":job_id,"done":true,"error":error}),
        };
        jobs.lock().unwrap().remove(&job_id);
        let _ = app.emit("archive:progress", event);
    });
    json!({"ok":true,"jobId":response_id})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelPayload {
    job_id: String,
}
#[tauri::command]
pub fn archive_cancel(state: State<'_, AppState>, payload: CancelPayload) -> Value {
    if let Some(cancel) = state.archive_jobs.lock().unwrap().get(&payload.job_id) {
        cancel.store(true, Ordering::Release);
    }
    json!({"ok":true})
}
