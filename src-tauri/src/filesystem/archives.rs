use crate::{
    error::NativeError,
    filesystem::{paths, Filesystem},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub provider_id: String,
    pub path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequest {
    pub job_id: String,
    pub action: String,
    pub sources: Vec<Location>,
    pub target: Location,
    pub name: String,
}

pub fn valid_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.chars().count() == 4
        && stem
            .chars()
            .nth(3)
            .is_some_and(|c| "123456789¹²³".contains(c)));
    !reserved
        && !name.is_empty()
        && name == name.trim()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| c.is_control() || "/\\:".contains(c))
}
pub fn validate(request: &ArchiveRequest) -> Result<(), NativeError> {
    if request.job_id.is_empty()
        || request.job_id.len() > 128
        || !valid_name(&request.name)
        || !matches!(request.action.as_str(), "create" | "extract")
        || request.sources.is_empty()
        || request.sources.len() > 1000
        || (request.action == "extract" && request.sources.len() != 1)
        || (request.action == "create" && !request.name.to_ascii_lowercase().ends_with(".zip"))
    {
        return Err(NativeError::new(
            "EINVAL",
            "Invalid archive operation or destination name",
        ));
    }
    if request.target.provider_id != "local"
        || request.sources.iter().any(|s| s.provider_id != "local")
    {
        return Err(NativeError::new(
            "ENOTSUPPORTED",
            "Archives require local files and folders, including mounted network shares",
        ));
    }
    Ok(())
}
pub fn bundled_binary() -> Result<PathBuf, NativeError> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(format!("vesperwind-archive{extension}")));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!(
                    "vesperwind-archive-{}{extension}",
                    env!("VESPERWIND_TARGET_TRIPLE")
                )),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.is_absolute() && p.is_file())
        .ok_or_else(|| {
            NativeError::new(
                "EARCHIVE_SIDECAR",
                "The bundled archive worker is missing; rebuild the application",
            )
        })
}
fn cancelled() -> NativeError {
    NativeError::new("ECANCELLED", "Archive operation cancelled")
}
pub fn run_worker(
    binary: &Path,
    args: &[String],
    cwd: Option<&Path>,
    cancel: &AtomicBool,
    progress: &(impl Fn(Value) + Sync),
) -> Result<String, NativeError> {
    if cancel.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| NativeError::from_io(&e, "Unable to start the bundled archive worker"))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let version = args.first().is_some_and(|s| s == "--version");
    thread::scope(|scope| {
        let output = scope.spawn(move || {
            let mut failure = None;
            let mut text = String::new();
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if version => text = line,
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(event) if event.get("error").is_some() => {
                            failure = Some(NativeError::new(
                                event["error"]["code"].as_str().unwrap_or("EARCHIVE_WORKER"),
                                event["error"]["message"]
                                    .as_str()
                                    .unwrap_or("Archive operation failed"),
                            ));
                        }
                        Ok(event) => {
                            if !cancel.load(Ordering::Acquire) && event["done"] != true {
                                progress(event);
                            }
                        }
                        Err(_) => {
                            failure = Some(NativeError::new(
                                "EARCHIVE_PROTOCOL",
                                "Invalid archive worker response",
                            ))
                        }
                    },
                    Err(e) => {
                        failure = Some(NativeError::from_io(
                            &e,
                            "Unable to read archive worker output",
                        ));
                        break;
                    }
                }
            }
            (text, failure)
        });
        let errors = scope.spawn(move || {
            let mut result = Vec::new();
            let mut block = [0; 4096];
            while let Ok(n) = stderr.read(&mut block) {
                if n == 0 {
                    break;
                }
                result.extend_from_slice(&block[..n]);
                if result.len() > 8192 {
                    result.drain(..result.len() - 8192);
                }
            }
            String::from_utf8_lossy(&result).into_owned()
        });
        let start = Instant::now();
        let status = loop {
            if cancel.load(Ordering::Acquire)
                || (version && start.elapsed() > Duration::from_secs(5))
            {
                let _ = child.kill();
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(e);
                }
            }
        };
        let (text, failure) = output.join().unwrap();
        let errors = errors.join().unwrap();
        if cancel.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let status =
            status.map_err(|e| NativeError::from_io(&e, "Unable to wait for archive worker"))?;
        if let Some(failure) = failure {
            return Err(failure.with_native_error(errors));
        }
        if !status.success() {
            return Err(NativeError::new("EARCHIVE_WORKER", "Archive worker failed")
                .with_native_error(errors));
        }
        Ok(text)
    })
}
pub fn perform(
    filesystem: &Filesystem,
    request: &ArchiveRequest,
    cancel: Arc<AtomicBool>,
    progress: impl Fn(Value) + Sync,
) -> Result<Value, NativeError> {
    validate(request)?;
    let logical_target = paths::resolve_inside_root(filesystem, &request.target.path)?;
    let target = paths::verify_existing_inside_root(filesystem, &logical_target)?;
    if !target.is_dir() {
        return Err(NativeError::new("ENOTDIR", "Choose a destination folder"));
    }
    let mut sources = Vec::new();
    for source in &request.sources {
        let logical = paths::resolve_inside_root(filesystem, &source.path)?;
        let metadata = fs::symlink_metadata(&logical)
            .map_err(|e| NativeError::from_io(&e, "Archive source is unavailable"))?;
        if metadata.file_type().is_symlink() {
            return Err(NativeError::new(
                "EARCHIVE_UNSAFE_ENTRY",
                "Archive sources cannot be links",
            ));
        }
        let physical = paths::verify_existing_inside_root(filesystem, &logical)?;
        if target.starts_with(&physical) {
            return Err(NativeError::new(
                "ECYCLE",
                "Archive destination cannot be inside a selected source folder",
            ));
        }
        sources.push(physical.to_string_lossy().into_owned());
    }
    let binary = bundled_binary()?;
    let names: std::collections::HashSet<_> = sources
        .iter()
        .map(|source| {
            Path::new(source)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
        })
        .collect();
    if names.len() != sources.len() {
        return Err(NativeError::new(
            "EARCHIVE_DUPLICATE",
            "Selected sources have duplicate names; archive them separately",
        ));
    }
    let version = run_worker(&binary, &["--version".into()], None, &cancel, &progress)?;
    if !compatible_worker(&version) {
        return Err(NativeError::new(
            "EARCHIVE_VERSION",
            "Bundled archive worker version mismatch",
        ));
    }
    let stage = target.join(format!(".vesperwind-archive-{}", uuid::Uuid::new_v4()));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&stage)
        .map_err(|e| NativeError::from_io(&e, "Unable to create archive staging folder"))?;
    let result = (|| {
        let output = if request.action == "create" {
            stage.join("output.zip")
        } else {
            stage.clone()
        };
        let args = if request.action == "create" {
            let mut args = vec!["create".into(), output.to_string_lossy().into_owned()];
            args.extend(sources);
            args
        } else {
            vec!["extract".into(), sources[0].clone()]
        };
        run_worker(&binary, &args, Some(&stage), &cancel, &progress)?;
        if let Err(error) = run_worker(
            &binary,
            &[
                "publish".into(),
                output.to_string_lossy().into_owned(),
                target.join(&request.name).to_string_lossy().into_owned(),
            ],
            None,
            &cancel,
            &progress,
        ) {
            if !matches!(fs::symlink_metadata(&output), Err(ref e) if e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(error);
            }
        }
        Ok(
            json!({"action": request.action, "targetDirectory": logical_target, "destinationPath": logical_target.join(&request.name)}),
        )
    })();
    let cleanup = fs::remove_dir_all(&stage);
    if let Err(e) = cleanup {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(NativeError::new(
                "EARCHIVE_CLEANUP",
                "Unable to clean up archive staging folder",
            )
            .with_path(&stage)
            .with_native_error(e.to_string()));
        }
    }
    result
}
fn compatible_worker(version: &str) -> bool {
    version.trim() == "vesperwind-archive/1 libarchive/libarchive 3.8.9 zip,tar,tgz,rar,rar5,7z liblzma/5.8.3 codecs=copy,lzma,lzma2 memory=536870912"
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_workers_without_7z_lzma2_or_memory_budget_are_rejected() {
        assert!(!compatible_worker(
            "vesperwind-archive/1 libarchive/libarchive 3.8.9 zip,tar,tgz,rar,rar5"
        ));
        let expected = "vesperwind-archive/1 libarchive/libarchive 3.8.9 zip,tar,tgz,rar,rar5,7z liblzma/5.8.3 codecs=copy,lzma,lzma2 memory=536870912";
        assert!(compatible_worker(expected));
        assert!(!compatible_worker(&expected.replace(",lzma2", "")));
        assert!(!compatible_worker(
            &expected.replace("memory=536870912", "memory=unlimited")
        ));
        assert!(!compatible_worker(&expected.replace("/1 ", "/2 ")));
    }
    #[test]
    fn destination_names_reject_cross_platform_escapes() {
        for name in [
            "..",
            "/tmp",
            "C:\\foo",
            "a/b",
            "a:stream",
            "\\\\host\\share",
            "CON.zip",
            "COM¹.zip",
            "trailing.",
        ] {
            assert!(!valid_name(name), "{name}");
        }
        assert!(valid_name("Книга.zip"));
    }
    #[test]
    fn cancellation_prevents_child_launch() {
        let cancel = AtomicBool::new(true);
        assert_eq!(
            run_worker(
                Path::new("/does-not-exist"),
                &["extract".into()],
                None,
                &cancel,
                &|_| {}
            )
            .unwrap_err()
            .code,
            "ECANCELLED"
        );
    }
    #[test]
    #[ignore = "Requires the bundled worker built with npm run build:archives"]
    fn real_archive_workflow_checks_formats_security_and_cleanup() {
        bundled_binary().expect("Build the bundled archive worker first");
        let root =
            std::env::temp_dir().join(format!("vesperwind-rust-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let filesystem = Filesystem::from_root(&root, root.clone()).unwrap();
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/archives");
        let run = |name: &str, destination: &str| {
            let source = root.join(name);
            fs::copy(fixtures.join(name), &source).unwrap();
            perform(
                &filesystem,
                &ArchiveRequest {
                    job_id: uuid::Uuid::new_v4().to_string(),
                    action: "extract".into(),
                    name: destination.into(),
                    sources: vec![Location {
                        provider_id: "local".into(),
                        path: source.to_string_lossy().into_owned(),
                    }],
                    target: Location {
                        provider_id: "local".into(),
                        path: root.to_string_lossy().into_owned(),
                    },
                },
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
        };
        for name in [
            "safe.zip",
            "safe.tar",
            "safe.tgz",
            "rar_binary_data.rar",
            "rar5_stored.rar",
            "rar5_compressed.rar",
            "safe-copy.7z",
            "safe-lzma.7z",
            "safe-lzma2.7z",
            "safe-solid-lzma2.7z",
            "unicode-names.7z",
            "safe-bcj-lzma2.7z",
        ] {
            run(name, &format!("extracted-{name}")).unwrap();
            if name.ends_with(".7z") && name != "safe-bcj-lzma2.7z" {
                let output = root.join(format!("extracted-{name}"));
                assert_eq!(
                    fs::read(output.join("folder/read me.txt")).unwrap(),
                    b"archive fixture\n"
                );
                assert_eq!(
                    fs::read_to_string(output.join("folder/Книга/Глава 1.txt")).unwrap(),
                    "Привет, 7z!\n"
                );
                assert_eq!(
                    fs::read(output.join("folder/binary.bin")).unwrap(),
                    (0..2048).map(|i| (i % 256) as u8).collect::<Vec<_>>()
                );
                assert!(output.join("folder/empty directory").is_dir());
                assert_eq!(
                    fs::metadata(output.join("folder/empty.txt")).unwrap().len(),
                    0
                );
                assert_eq!(
                    fs::read(root.join(name)).unwrap(),
                    fs::read(fixtures.join(name)).unwrap()
                );
            }
        }
        for (name, code) in [
            ("encrypted.7z", "EARCHIVE_ENCRYPTED"),
            ("encrypted-header.7z", "EARCHIVE_ENCRYPTED"),
            ("corrupted.7z", "EARCHIVE_FORMAT"),
            ("truncated.7z", "EARCHIVE_FORMAT"),
            ("unsupported-bzip2.7z", "EARCHIVE_UNSUPPORTED_CODEC"),
            ("huge-dictionary.7z", "EARCHIVE_LIMIT"),
            ("unsafe-link.7z", "EARCHIVE_UNSAFE_ENTRY"),
            ("duplicate.7z", "EARCHIVE_FORMAT"),
            ("dotdot.7z", "EARCHIVE_UNSAFE_PATH"),
            ("absolute.7z", "EARCHIVE_UNSAFE_PATH"),
            ("drive.7z", "EARCHIVE_UNSAFE_PATH"),
            ("unc.7z", "EARCHIVE_UNSAFE_PATH"),
            ("ads.7z", "EARCHIVE_UNSAFE_PATH"),
            ("reserved.7z", "EARCHIVE_UNSAFE_PATH"),
            ("reserved-nul.7z", "EARCHIVE_UNSAFE_PATH"),
            ("trailing.7z", "EARCHIVE_UNSAFE_PATH"),
            ("backslash.7z", "EARCHIVE_UNSAFE_PATH"),
            ("control.7z", "EARCHIVE_UNSAFE_PATH"),
        ] {
            assert_eq!(
                run(name, &format!("rejected-{name}")).unwrap_err().code,
                code,
                "{name}"
            );
            assert!(!root.join(format!("rejected-{name}")).exists());
        }
        assert!(!root.join("outside.txt").exists());
        assert_eq!(
            run("safe-lzma2.7z", "extracted-safe-lzma2.7z")
                .unwrap_err()
                .code,
            "EARCHIVE_PUBLISH"
        );
        // A real solid stream publishes only after completion; progress reaches
        // the Rust backend while output is still private.
        let source = root.join("large-solid-lzma2.7z");
        fs::copy(fixtures.join("large-solid-lzma2.7z"), &source).unwrap();
        let mut large_request = ArchiveRequest {
            job_id: uuid::Uuid::new_v4().to_string(),
            action: "extract".into(),
            name: "large-output".into(),
            sources: vec![Location {
                provider_id: "local".into(),
                path: source.to_string_lossy().into_owned(),
            }],
            target: Location {
                provider_id: "local".into(),
                path: root.to_string_lossy().into_owned(),
            },
        };
        let progressed = AtomicBool::new(false);
        perform(
            &filesystem,
            &large_request,
            Arc::new(AtomicBool::new(false)),
            |_| {
                progressed.store(true, Ordering::Release);
                assert!(!root.join("large-output").exists());
            },
        )
        .unwrap();
        assert!(progressed.load(Ordering::Acquire));
        for name in [
            "large/first.bin",
            "large/nested/second.bin",
            "large/nested/Книга/third.bin",
        ] {
            assert_eq!(
                fs::metadata(root.join("large-output").join(name))
                    .unwrap()
                    .len(),
                128 * 1024 * 1024
            );
        }
        large_request.name = "cancelled-7z".into();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress_cancel = Arc::clone(&cancel);
        assert_eq!(
            perform(&filesystem, &large_request, cancel, |_| {
                progress_cancel.store(true, Ordering::Release);
            })
            .unwrap_err()
            .code,
            "ECANCELLED"
        );
        assert!(!root.join("cancelled-7z").exists());
        let book = root.join("Книга");
        fs::create_dir(&book).unwrap();
        fs::write(book.join("Глава.txt"), "Unicode ZIP round trip").unwrap();
        let destination = root.join("Архивы");
        fs::create_dir(&destination).unwrap();
        let mut request = ArchiveRequest {
            job_id: uuid::Uuid::new_v4().to_string(),
            action: "create".into(),
            name: "Книга.zip".into(),
            sources: vec![Location {
                provider_id: "local".into(),
                path: book.to_string_lossy().into_owned(),
            }],
            target: Location {
                provider_id: "local".into(),
                path: destination.to_string_lossy().into_owned(),
            },
        };
        perform(
            &filesystem,
            &request,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        request.action = "extract".into();
        request.sources[0].path = destination.join("Книга.zip").to_string_lossy().into_owned();
        request.name = "распаковано".into();
        perform(
            &filesystem,
            &request,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("распаковано/Книга/Глава.txt")).unwrap(),
            "Unicode ZIP round trip"
        );
        for name in ["dotdot.zip", "drive.tar", "symlink.tar", "hardlink.tar"] {
            assert!(run(name, &format!("rejected-{name}")).is_err());
            assert!(!root.join(format!("rejected-{name}")).exists());
        }
        assert_eq!(
            run("safe.zip", "extracted-safe.zip").unwrap_err().code,
            "EARCHIVE_PUBLISH"
        );
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vesperwind-archive-")));
        let source = root.join("cancellable.bin");
        fs::File::create(&source)
            .unwrap()
            .set_len(64 * 1024 * 1024)
            .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress_cancel = Arc::clone(&cancel);
        let result = perform(
            &filesystem,
            &ArchiveRequest {
                job_id: uuid::Uuid::new_v4().to_string(),
                action: "create".into(),
                name: "cancelled.zip".into(),
                sources: vec![Location {
                    provider_id: "local".into(),
                    path: source.to_string_lossy().into_owned(),
                }],
                target: Location {
                    provider_id: "local".into(),
                    path: root.to_string_lossy().into_owned(),
                },
            },
            cancel,
            |_| {
                progress_cancel.store(true, Ordering::Release);
            },
        );
        assert_eq!(result.unwrap_err().code, "ECANCELLED");
        assert!(!root.join("cancelled.zip").exists());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vesperwind-archive-")));
        fs::remove_dir_all(root).unwrap();
    }
}
