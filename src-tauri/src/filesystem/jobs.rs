//! Killable operation workers. No filesystem/session locks cross a job boundary.
use super::{
    operations::{OperationRequest, OperationResult},
    Filesystem,
};
use crate::{
    error::NativeError,
    ssh::{OperationConnection, SshManager},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const DELETE_TIMEOUT_MS: u64 = 30_000;
pub const OPERATION_TIMEOUT_MS: u64 = 600_000;
thread_local! { static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) }; }
pub(crate) fn checkpoint() -> Result<(), NativeError> {
    if DEADLINE.with(|d| d.get().is_some_and(|d| Instant::now() >= d)) {
        Err(NativeError::new(
            "ETIMEDOUT",
            "The file operation timed out",
        ))
    } else {
        Ok(())
    }
}

#[derive(Default)]
struct JobRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    early: Vec<(String, Instant)>,
    closed: bool,
}
#[derive(Default)]
pub struct OperationJobs {
    jobs: Mutex<JobRegistry>,
}
impl OperationJobs {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.early
            .retain(|(_, time)| time.elapsed() < Duration::from_secs(120));
        let early = jobs.early.iter().any(|(key, _)| key == id);
        jobs.early.retain(|(key, _)| key != id);
        let cancelled = early || jobs.closed;
        jobs.active
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(AtomicBool::new(cancelled)))
            .clone()
    }
    pub fn cancel(&self, id: &str) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(job) = jobs.active.get(id) {
            job.store(true, Ordering::Release);
        } else {
            // Honor a cancel delivered before registration, without retaining
            // an unbounded collection of late cancellation tombstones.
            jobs.early
                .retain(|(key, time)| key != id && time.elapsed() < Duration::from_secs(120));
            if jobs.early.len() >= 1024 {
                jobs.early.remove(0);
            }
            jobs.early.push((id.to_owned(), Instant::now()));
        }
    }
    pub fn finish(&self, id: &str) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.active.remove(id);
        jobs.early.retain(|(key, _)| key != id);
    }
    pub fn shutdown(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.closed = true;
        for job in jobs.active.values() {
            job.store(true, Ordering::Release);
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Input {
    request: OperationRequest,
    root: PathBuf,
    home: PathBuf,
    desktop: bool,
    remote: Vec<OperationConnection>,
}

pub fn execute(
    filesystem: &Filesystem,
    ssh: &SshManager,
    request: OperationRequest,
    cancelled: &AtomicBool,
) -> Result<OperationResult, NativeError> {
    let timeout = request
        .timeout_ms
        .unwrap_or(if request.action == "delete" {
            DELETE_TIMEOUT_MS
        } else {
            OPERATION_TIMEOUT_MS
        })
        .clamp(1, OPERATION_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let affected = request
        .source_path
        .clone()
        .or(request.target_directory.clone())
        .unwrap_or_default();
    if cancelled.load(Ordering::Acquire) {
        return Err(stopped("ECANCELLED", &affected));
    }
    let remote = ssh.operation_connections(&request)?;
    let input = Input {
        request,
        root: filesystem.root().to_owned(),
        home: filesystem.home().to_owned(),
        desktop: filesystem.is_desktop(),
        remote,
    };
    let encoded = serde_json::to_vec(&input)
        .map_err(|_| NativeError::new("EINVAL", "Unable to encode the operation"))?;
    if encoded.len() > 2 * 1024 * 1024 {
        return Err(
            NativeError::new("EINVAL", "The operation request is too large").with_path(&affected),
        );
    }
    let mut command = Command::new(
        std::env::current_exe()
            .map_err(|e| NativeError::from_io(&e, "Unable to locate the operation worker"))?,
    );
    command
        .arg("--filesystem-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| NativeError::from_io(&e, "Unable to start the file operation worker"))?;
    // Read output concurrently, so even a long native path cannot fill a pipe
    // and deadlock the parent waiting for exit. Protocol output is bounded.
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout
            .take(2 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    // The worker only reads stdin before any OS operation. This payload is
    // bounded to 2 MiB, and includes credentials solely in an anonymous pipe.
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(&encoded));
    let result = loop {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            let _ = child.kill();
            break Err(stopped(
                if cancelled.load(Ordering::Acquire) {
                    "ECANCELLED"
                } else {
                    "ETIMEDOUT"
                },
                &affected,
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    break Err(NativeError::new(
                        "EWORKER_LOST",
                        "The file operation worker stopped unexpectedly",
                    )
                    .with_path(&affected));
                }
                break Ok(());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                let _ = child.kill();
                break Err(
                    NativeError::from_io(&e, "Unable to monitor the file operation worker")
                        .with_path(&affected),
                );
            }
        }
    };
    if let Err(error) = result {
        let _ = child.kill();
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = writer.join();
            let _ = reader.join();
        });
        return Err(error);
    }
    let _ = child.wait();
    let _ = writer.join();
    let bytes = reader
        .join()
        .map_err(|_| NativeError::new("EWORKER_LOST", "Worker output was lost"))?
        .map_err(|e| NativeError::from_io(&e, "Unable to read worker result"))?;
    let response: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| NativeError::new("EWORKER_LOST", "Invalid worker response"))?;
    if response["ok"] == true {
        serde_json::from_value(response["result"].clone())
            .map_err(|_| NativeError::new("EWORKER_LOST", "Invalid operation result"))
    } else {
        let mut error: NativeError = serde_json::from_value(response["error"].clone())
            .map_err(|_| NativeError::new("EWORKER_LOST", "Invalid operation error"))?;
        if error.path.is_none() {
            error = error.with_path(&affected);
        }
        Err(error)
    }
}
fn stopped(code: &str, path: &str) -> NativeError {
    NativeError::new(code, if code == "ETIMEDOUT" {
        "The operation did not complete within the allowed time. The worker was terminated and Vesperwind is ready for another operation."
    } else { "The operation was cancelled and its worker was stopped" }).with_path(path)
}

/// Called before constructing Tauri. A helper never opens windows or starts services.
pub fn run_filesystem_helper() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--filesystem-helper") {
        return false;
    }
    let result = (|| {
        let mut bytes = vec![];
        std::io::stdin()
            .take(2 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| NativeError::from_io(&e, "Unable to read operation"))?;
        let input: Input = serde_json::from_slice(&bytes)
            .map_err(|_| NativeError::new("EINVAL", "Invalid operation request"))?;
        DEADLINE.with(|d| {
            d.set(Some(
                Instant::now()
                    + Duration::from_millis(
                        input.request.timeout_ms.unwrap_or(OPERATION_TIMEOUT_MS),
                    ),
            ))
        });
        let filesystem = if input.desktop {
            Filesystem::from_environment()?
        } else {
            Filesystem::from_root(input.root, input.home)?
        };
        if input.remote.is_empty() {
            super::operations::perform(&filesystem, input.request)
        } else {
            SshManager::from_operation_connections(input.remote)?
                .operate(&filesystem, input.request)
        }
    })();
    let response = match result {
        Ok(result) => serde_json::json!({"ok":true,"result":result}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    let _ = std::io::stdout().write_all(&serde_json::to_vec(&response).unwrap());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_cancel_and_next_job_are_independent() {
        let jobs = OperationJobs::default();
        jobs.cancel("old");
        assert!(jobs.register("old").load(Ordering::Acquire));
        assert!(!jobs.register("next").load(Ordering::Acquire));
        jobs.finish("old");
        jobs.shutdown();
        assert!(jobs.register("next").load(Ordering::Acquire));
    }
    #[test]
    fn late_cancellations_are_bounded_and_do_not_evict_active_jobs() {
        let jobs = OperationJobs::default();
        let active = jobs.register("active");
        for i in 0..2048 {
            jobs.cancel(&format!("late-{i}"));
        }
        assert_eq!(jobs.jobs.lock().unwrap().early.len(), 1024);
        jobs.cancel("active");
        assert!(active.load(Ordering::Acquire));
    }
    #[test]
    fn expired_deadline_is_structured() {
        DEADLINE.with(|d| d.set(Some(Instant::now())));
        assert_eq!(checkpoint().unwrap_err().code, "ETIMEDOUT");
        DEADLINE.with(|d| d.set(None));
        assert!(checkpoint().is_ok());
    }
}
