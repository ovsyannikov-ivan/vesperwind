//! Killable operation workers. No filesystem/session locks cross a job boundary.
use super::{
    operations::{OperationRequest, OperationResult},
    Filesystem,
};
use crate::{
    error::NativeError,
    remote::{OperationConnections, RemoteProviders},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::HashMap,
    io::{BufRead, Read, Write},
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
#[cfg(test)]
pub(crate) fn set_test_deadline(deadline: Option<Instant>) {
    DEADLINE.with(|d| d.set(deadline));
}
/// Set in the filesystem helper when its parent asks it to stop, so the
/// operation can clean up (for example a partial destination) before exit.
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
/// How long the parent waits for a cooperative stop before killing the helper.
const CANCEL_GRACE: Duration = Duration::from_secs(3);
/// The byte a parent writes to the helper's stdin to request a stop.
const CANCEL_BYTE: u8 = b'c';

pub(crate) fn checkpoint() -> Result<(), NativeError> {
    if CANCEL_REQUESTED.load(Ordering::Acquire) {
        return Err(NativeError::new(
            "ECANCELLED",
            "The operation was cancelled and its worker was stopped",
        ));
    }
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
    #[cfg(debug_assertions)]
    #[serde(default)]
    parent_probe: bool,
    request: OperationRequest,
    root: PathBuf,
    home: PathBuf,
    desktop: bool,
    // Flattened so the frame keeps its `remote` field for SFTP snapshots.
    #[serde(flatten)]
    remote: OperationConnections,
}

/// Copy and move with a remote side transfer file contents. They are not
/// bounded by the overall operation deadline but by inactivity: the helper
/// reports progress, and an operation that makes none for `IDLE_TIMEOUT_MS`
/// is stopped. Socket timeouts inside the helper are shorter than this.
pub const TRANSFER_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
pub const IDLE_TIMEOUT_MS: u64 = 120_000;
/// Upper bound of one helper output line (progress or result).
const MAX_FRAME: u64 = 2 * 1024 * 1024;

pub fn is_remote_transfer(request: &OperationRequest) -> bool {
    matches!(request.action.as_str(), "copy" | "move")
        && [&request.filesystem_id, &request.target_filesystem_id]
            .into_iter()
            .flatten()
            .any(|provider| provider != "local")
}

pub fn execute(
    filesystem: &Filesystem,
    remote_providers: &RemoteProviders,
    request: OperationRequest,
    cancelled: &AtomicBool,
) -> Result<OperationResult, NativeError> {
    execute_with_progress(filesystem, remote_providers, request, cancelled, |_| {})
}

/// `on_progress` receives the bytes transferred so far, from this thread.
pub fn execute_with_progress(
    filesystem: &Filesystem,
    remote_providers: &RemoteProviders,
    request: OperationRequest,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(u64),
) -> Result<OperationResult, NativeError> {
    let transfer = is_remote_transfer(&request);
    let timeout = request
        .timeout_ms
        .unwrap_or(if request.action == "delete" {
            DELETE_TIMEOUT_MS
        } else {
            OPERATION_TIMEOUT_MS
        })
        .clamp(
            1,
            if transfer {
                TRANSFER_TIMEOUT_MS
            } else {
                OPERATION_TIMEOUT_MS
            },
        );
    let idle_timeout = transfer.then_some(Duration::from_millis(IDLE_TIMEOUT_MS));
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let affected = request
        .source_path
        .clone()
        .or(request.target_directory.clone())
        .unwrap_or_default();
    if cancelled.load(Ordering::Acquire) {
        return Err(stopped("ECANCELLED", &affected));
    }
    let mut request = request;
    request.timeout_ms = Some(timeout);
    let remote = remote_providers.operation_connections(&request)?;
    let input = Input {
        #[cfg(debug_assertions)]
        parent_probe: false,
        request,
        root: filesystem.root().to_owned(),
        home: filesystem.home().to_owned(),
        desktop: filesystem.is_desktop(),
        remote,
    };
    let encoded = zeroize::Zeroizing::new(
        serde_json::to_vec(&input)
            .map_err(|_| NativeError::new("EINVAL", "Unable to encode the operation"))?,
    );
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
    // and deadlock the parent waiting for exit. Every line is bounded.
    let stdout = child.stdout.take().unwrap();
    let (progress_sender, progress) = std::sync::mpsc::channel::<u64>();
    let reader = std::thread::spawn(move || {
        let mut stdout = std::io::BufReader::new(stdout);
        let mut last = Vec::new();
        loop {
            let mut line = Vec::new();
            let read = (&mut stdout).take(MAX_FRAME).read_until(b'\n', &mut line)?;
            if read == 0 {
                break;
            }
            match serde_json::from_slice::<serde_json::Value>(&line) {
                Ok(frame) if frame.get("progress").is_some() => {
                    let _ = progress_sender.send(frame["progress"]["bytes"].as_u64().unwrap_or(0));
                }
                _ => last = line,
            }
        }
        Ok::<_, std::io::Error>(last)
    });
    // The worker reads its frame from stdin before any OS operation. This
    // payload is bounded to 2 MiB, and includes credentials solely in an
    // anonymous pipe. Afterwards the pipe carries only a stop request.
    let mut stdin = child.stdin.take().unwrap();
    let pipe: Arc<Mutex<Option<std::process::ChildStdin>>> = Arc::new(Mutex::new(None));
    let writer = {
        let pipe = Arc::clone(&pipe);
        std::thread::spawn(move || {
            stdin.write_all(&(encoded.len() as u32).to_le_bytes())?;
            stdin.write_all(&encoded)?;
            // Keep the pipe open until the child exits. Closing it (including
            // parent death) is the worker's lifetime signal.
            *pipe.lock().unwrap_or_else(|e| e.into_inner()) = Some(stdin);
            Ok::<_, std::io::Error>(())
        })
    };
    // Asks the helper to stop at its next checkpoint (so it can remove a
    // partial destination), then kills it if it does not exit in time.
    let stop = |child: &mut std::process::Child| {
        if let Some(stdin) = pipe.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = stdin.write_all(&[CANCEL_BYTE]);
            let _ = stdin.flush();
            let until = Instant::now() + CANCEL_GRACE;
            while Instant::now() < until {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let _ = child.kill();
    };
    let mut last_activity = Instant::now();
    let result = loop {
        while let Ok(bytes) = progress.try_recv() {
            last_activity = Instant::now();
            on_progress(bytes);
        }
        let idle = idle_timeout.is_some_and(|limit| last_activity.elapsed() >= limit);
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline || idle {
            stop(&mut child);
            break Err(if cancelled.load(Ordering::Acquire) {
                stopped("ECANCELLED", &affected)
            } else if idle {
                NativeError::new(
                    "ETIMEDOUT",
                    "The transfer made no progress and was stopped. Vesperwind is ready for another operation.",
                )
                .with_path(&affected)
            } else {
                stopped("ETIMEDOUT", &affected)
            });
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
    while let Ok(bytes) = progress.try_recv() {
        on_progress(bytes);
    }
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

/// Progress of the operation running in this filesystem helper, written to
/// stdout as `{"progress":{"bytes":N}}` lines at most every 250 ms. Outside a
/// helper this does nothing.
static PROGRESS: Mutex<Option<(u64, Instant)>> = Mutex::new(None);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) fn report_progress(bytes: u64) {
    let mut state = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    let Some((total, last)) = state.as_mut() else {
        return;
    };
    *total += bytes;
    if last.elapsed() < PROGRESS_INTERVAL {
        return;
    }
    *last = Instant::now();
    let frame = format!("{{\"progress\":{{\"bytes\":{total}}}}}\n");
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(frame.as_bytes());
    let _ = stdout.flush();
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
        let mut stdin = std::io::stdin();
        let mut length = [0u8; 4];
        stdin
            .read_exact(&mut length)
            .map_err(|e| NativeError::from_io(&e, "Unable to read operation frame"))?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > 2 * 1024 * 1024 {
            return Err(NativeError::new("EINVAL", "Invalid operation frame"));
        }
        let mut bytes = zeroize::Zeroizing::new(vec![0; length]);
        stdin
            .read_exact(&mut bytes)
            .map_err(|e| NativeError::from_io(&e, "Unable to read operation"))?;
        let input: Input = serde_json::from_slice(&bytes)
            .map_err(|_| NativeError::new("EINVAL", "Invalid operation request"))?;
        std::thread::spawn(move || {
            let mut byte = [0];
            // Only a stop request may follow the frame. EOF (the owning
            // process disappeared) or any other byte ends the helper even if
            // the operation thread is stuck.
            loop {
                match stdin.read(&mut byte) {
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Ok(1) if byte[0] == CANCEL_BYTE => {
                        CANCEL_REQUESTED.store(true, Ordering::Release);
                        continue;
                    }
                    _ => break,
                }
            }
            #[cfg(unix)]
            unsafe {
                libc::_exit(3);
            }
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
                TerminateProcess(GetCurrentProcess(), 3);
            }
            #[cfg(not(any(unix, windows)))]
            std::process::exit(3);
        });
        #[cfg(debug_assertions)]
        if input.parent_probe {
            std::thread::sleep(Duration::from_secs(30));
        }
        *PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((0, Instant::now() - PROGRESS_INTERVAL));
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
            super::remote_ops::operate(&filesystem, &input.remote.open()?, input.request)
        }
    })();
    let response = match result {
        Ok(result) => serde_json::json!({"ok":true,"result":result}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    let mut line = serde_json::to_vec(&response).unwrap();
    line.push(b'\n');
    let _ = std::io::stdout().write_all(&line);
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
    fn helper_frame_keeps_its_remote_field_and_accepts_the_previous_shape() {
        let frame = serde_json::json!({
            "request": {"action":"delete","sourcePath":"/a","targetDirectory":null,"name":null,
                "filesystemId":"local","targetFilesystemId":null},
            "root": "/", "home": "/", "desktop": false, "remote": []
        });
        let input: Input = serde_json::from_value(frame).unwrap();
        assert!(input.remote.is_empty());
        let encoded = serde_json::to_value(&input).unwrap();
        assert_eq!(encoded["remote"], serde_json::json!([]));
        assert_eq!(encoded["request"]["action"], "delete");
    }
    #[test]
    fn expired_deadline_is_structured() {
        DEADLINE.with(|d| d.set(Some(Instant::now())));
        assert_eq!(checkpoint().unwrap_err().code, "ETIMEDOUT");
        DEADLINE.with(|d| d.set(None));
        assert!(checkpoint().is_ok());
    }
}
