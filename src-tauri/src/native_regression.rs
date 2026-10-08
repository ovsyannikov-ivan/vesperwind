//! Opt-in debug regression entry point, using the real application managers.
//! Invoked by scripts/native-smoke.mjs and the Windows runner; absent in release.
use crate::{
    error::NativeError,
    filesystem::{jobs, operations::OperationRequest},
    AppState,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

fn event(root: &Path, events: &mut Vec<Value>, phase: &str, details: Value) {
    let mut value = details;
    value["phase"] = json!(phase);
    value["epochMs"] = json!(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64);
    events.push(value);
    fs::write(
        root.join("events.json"),
        serde_json::to_vec_pretty(events).unwrap(),
    )
    .unwrap();
}
pub fn start(app: &AppHandle) {
    let args: Vec<_> = std::env::args().collect();
    let properties_only = args.get(1).map(String::as_str) == Some("--properties-regression");
    if !properties_only && args.get(1).map(String::as_str) != Some("--native-regression") {
        return;
    }
    let Some(output) = args.get(2) else {
        app.exit(2);
        return;
    };
    let output = PathBuf::from(output);
    let app = app.clone();
    std::thread::spawn(move || {
        let result = if properties_only {
            run_properties(&app, &output)
        } else {
            run(&app, &output)
        };
        if let Err(error) = &result {
            eprintln!("Native regression failed: {error}");
            let _ = fs::write(output.join("failure.txt"), error.to_string());
        }
        app.exit(if result.is_ok() { 0 } else { 2 });
    });
}
fn run_properties(app: &AppHandle, output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use crate::filesystem::{properties, size};
    fs::create_dir_all(output)?;
    if output.join("events.json").exists() {
        return Err("Use a new properties regression output directory".into());
    }
    let state = app.state::<AppState>();
    let fixture = output.join("properties-fixture");
    fs::create_dir(&fixture)?;
    let file = fixture.join("report.txt");
    fs::write(&file, b"Properties native fixture")?;
    let folder = fixture.join("folder");
    fs::create_dir(&folder)?;
    let child = folder.join("child");
    fs::write(&child, [0u8; 19])?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640))?;
        fs::set_permissions(&child, fs::Permissions::from_mode(0o640))?;
        std::os::unix::fs::symlink(&fixture, fixture.join("cycle"))?;
    }
    let read = |path: &Path| {
        properties::read(&state.filesystem, &path.to_string_lossy())
            .map_err(|e| format!("{}: {}", e.code, e.message))
    };
    let before = read(&file)?;
    assert!(before.created_at.is_some());
    assert_eq!(before.size, Some(25));
    let mut events = vec![];
    event(
        output,
        &mut events,
        "metadata",
        serde_json::to_value(&before)?,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            before.permissions.as_ref().unwrap().mode.unwrap() & 0o777,
            0o640
        );
        let after = properties::update(
            &state.filesystem,
            &file.to_string_lossy(),
            &properties::PermissionUpdate {
                mode: Some(0o750),
                uid: None,
                gid: None,
            },
        )
        .map_err(|e| e.message)?;
        assert_eq!(
            after.permissions.as_ref().unwrap().mode.unwrap() & 0o777,
            0o750
        );
        event(output, &mut events, "chmod", serde_json::to_value(&after)?);
        properties::update(
            &state.filesystem,
            &folder.to_string_lossy(),
            &properties::PermissionUpdate {
                mode: Some(0o750),
                uid: None,
                gid: None,
            },
        )
        .map_err(|e| e.message)?;
        assert_eq!(fs::metadata(&child)?.mode() & 0o777, 0o640);
        let link = read(&fixture.join("cycle"))?;
        assert_eq!(link.entry_type, "symlink");
        assert!(!link.capabilities.change_mode);
        event(output, &mut events, "symlink", serde_json::to_value(&link)?);
        if unsafe { libc::geteuid() } != 0 {
            let denied = properties::update(
                &state.filesystem,
                &file.to_string_lossy(),
                &properties::PermissionUpdate {
                    mode: None,
                    uid: Some(0),
                    gid: None,
                },
            )
            .unwrap_err();
            assert_eq!(denied.code, "EACCES");
            event(
                output,
                &mut events,
                "denied-owner",
                serde_json::to_value(denied)?,
            );
        }
    }
    #[cfg(windows)]
    {
        assert!(before.permissions.is_none());
        assert!(!before.capabilities.change_mode);
    }
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let result = size::calculate(
        &state.filesystem,
        &state.ssh,
        "local",
        &fixture.to_string_lossy(),
        &cancelled,
        |_| {},
    )
    .map_err(|e| e.message)?;
    assert_eq!(result.errors, 0);
    assert!(!result.cancelled);
    #[cfg(unix)]
    assert_eq!(result.items, 4);
    #[cfg(windows)]
    assert_eq!(result.items, 3);
    assert!(result.bytes >= 44);
    event(
        output,
        &mut events,
        "folder-size",
        serde_json::to_value(result)?,
    );
    cancelled.store(true, std::sync::atomic::Ordering::Release);
    assert!(
        size::calculate(
            &state.filesystem,
            &state.ssh,
            "local",
            &fixture.to_string_lossy(),
            &cancelled,
            |_| {}
        )
        .map_err(|e| e.message)?
        .cancelled
    );
    event(
        output,
        &mut events,
        "finished",
        json!({"ok":true,"platform":std::env::consts::OS}),
    );
    Ok(())
}
fn run(app: &AppHandle, output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(output)?;
    if output.join("events.json").exists() {
        return Err("Use a new native regression output directory".into());
    }
    let state = app.state::<AppState>();
    let broker = Arc::clone(&state.conversion);
    let mut events = vec![];
    assert!(broker.snapshot().is_none());
    std::thread::sleep(Duration::from_secs(3));
    event(
        output,
        &mut events,
        "before-office",
        json!({"converterAbsent":true}),
    );
    std::thread::sleep(Duration::from_secs(2));
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/office");
    let mut first_generation = 0;
    for (index, (name, format)) in [
        ("minimal.pptx", "pptx"),
        ("representative.pptx", "pptx"),
        ("standard-4-3.pptx", "pptx"),
        ("custom-size.pptx", "pptx"),
        ("chart-workbook-cached.pptx", "pptx"),
        ("chart-workbook-no-cache.pptx", "pptx"),
        ("cocoa-structured.doc", "doc"),
        ("structured.rtf", "rtf"),
    ]
    .iter()
    .enumerate()
    {
        let result = broker
            .convert(
                app.clone(),
                uuid::Uuid::new_v4().to_string(),
                fs::read(fixtures.join(name))?,
                format.to_string(),
                90_000,
            )
            .map_err(|e| format!("{name}: {} {}", e.code, e.message))?;
        let generation = broker.snapshot().unwrap().0;
        if index == 0 {
            first_generation = generation;
        } else {
            assert_eq!(
                generation, first_generation,
                "warm conversion must reuse one view"
            );
        }
        let target = if *format == "pptx" { "pdf" } else { "docx" };
        fs::write(output.join(format!("{name}.{target}")), &result.bytes)?;
        event(
            output,
            &mut events,
            "converted",
            json!({"input":name,"generation":generation,"initMs":result.init_ms,"conversionMs":result.conversion_ms,"bytes":result.bytes.len(),"buildId":result.build_id}),
        );
    }
    broker.verify_network_isolation().map_err(|e| e.message)?;
    event(
        output,
        &mut events,
        "warm-office",
        json!({"externalFetchBlocked":true}),
    );
    std::thread::sleep(Duration::from_secs(2));
    // Observe actual idle destruction at the production timeout.
    let idle = Instant::now();
    while broker.snapshot().is_some() {
        if idle.elapsed() > crate::office::IDLE_TIMEOUT + Duration::from_secs(8) {
            return Err("idle teardown deadline failed".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    event(
        output,
        &mut events,
        "after-idle",
        json!({"converterAbsent":true}),
    );
    std::thread::sleep(Duration::from_secs(3));
    // New view after idle, then hard cancellation during a real conversion.
    let rebuilt = broker
        .convert(
            app.clone(),
            uuid::Uuid::new_v4().to_string(),
            fs::read(fixtures.join("minimal.pptx"))?,
            "pptx".into(),
            90_000,
        )
        .map_err(|e| e.message)?;
    assert_ne!(broker.snapshot().unwrap().0, first_generation);
    fs::write(output.join("after-idle.pdf"), rebuilt.bytes)?;
    let id = uuid::Uuid::new_v4().to_string();
    let cancel_broker = Arc::clone(&broker);
    let cancel_id = id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        cancel_broker.cancel(&cancel_id);
    });
    let cancelled = broker
        .convert(
            app.clone(),
            id,
            fs::read(fixtures.join("large-64.pptx"))?,
            "pptx".into(),
            90_000,
        )
        .err()
        .ok_or("conversion completed before cancellation fixture")?;
    assert_eq!(cancelled.code, "ECANCELLED");
    assert!(broker.snapshot().is_none());
    event(
        output,
        &mut events,
        "cancelled",
        json!({"code":cancelled.code}),
    );
    // Recover after hard cancellation with another actual DOC import.
    let recovered = broker
        .convert(
            app.clone(),
            uuid::Uuid::new_v4().to_string(),
            fs::read(fixtures.join("cocoa-structured.doc"))?,
            "doc".into(),
            90_000,
        )
        .map_err(|e| e.message)?;
    fs::write(output.join("after-cancel.docx"), recovered.bytes)?;
    delete_regressions(&state, output).map_err(|e| format!("{}: {}", e.code, e.message))?;
    event(
        output,
        &mut events,
        "finished",
        json!({"deleteRegression":true}),
    );
    Ok(())
}
fn delete_regressions(state: &AppState, output: &Path) -> Result<(), NativeError> {
    // A closed ownership pipe must stop an otherwise idle helper, including
    // abrupt parent loss. Never start deletion in this controlled probe.
    {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--filesystem-helper")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut pipe = child.stdin.take().unwrap();
        let input = serde_json::to_vec(&json!({"parent_probe":true,"root":state.filesystem.root(),"home":state.filesystem.home(),"desktop":state.filesystem.is_desktop(),"remote":[],"request":{"action":"delete","sourcePath":output.join("never-deleted-parent-probe")}})).unwrap();
        pipe.write_all(&(input.len() as u32).to_le_bytes()).unwrap();
        pipe.write_all(&input).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(child.try_wait().unwrap().is_none());
        drop(pipe);
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(exit) = child.try_wait().unwrap() {
                assert_eq!(exit.code(), Some(3));
                break;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NativeError::new(
                    "ETEST",
                    "Operation helper survived its ownership pipe",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let fixture = output.join("delete-fixtures");
    fs::create_dir(&fixture).unwrap();
    let delete = |path: &Path, timeout_ms| {
        jobs::execute(
            &state.filesystem,
            &state.ssh,
            OperationRequest {
                operation_id: Some(uuid::Uuid::new_v4().to_string()),
                timeout_ms: Some(timeout_ms),
                action: "delete".into(),
                source_path: Some(path.to_string_lossy().into_owned()),
                target_directory: None,
                name: None,
                filesystem_id: Some("local".into()),
                target_filesystem_id: None,
            },
            &std::sync::atomic::AtomicBool::new(false),
        )
    };
    let file = fixture.join("normal.txt");
    fs::write(&file, b"safe fixture").unwrap();
    delete(&file, 30_000)?;
    assert!(!file.exists());
    let folder = fixture.join("normal-folder");
    fs::create_dir_all(folder.join("child")).unwrap();
    fs::write(folder.join("child/data"), b"safe").unwrap();
    delete(&folder, 30_000)?;
    assert!(!folder.exists());
    let root = if cfg!(windows) {
        PathBuf::from(output.components().next().unwrap().as_os_str()).join("\\")
    } else {
        PathBuf::from("/")
    };
    assert_eq!(delete(&root, 30_000).unwrap_err().code, "EROOT_OPERATION");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let target = fixture.join("target.txt");
        fs::write(&target, b"must survive").unwrap();
        let link = fixture.join("link");
        symlink(&target, &link).unwrap();
        delete(&link, 30_000)?;
        assert!(target.exists());
        let protected = fixture.join("permission-fixture");
        fs::create_dir(&protected).unwrap();
        fs::write(protected.join("child"), b"owned fixture").unwrap();
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o555)).unwrap();
        let result = delete(&protected, 30_000);
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap_err().code, "EACCES");
        let next = fixture.join("after-denial");
        fs::write(&next, b"safe").unwrap();
        delete(&next, 30_000)?;
        delete(&protected, 30_000)?;
    }
    let timeout = fixture.join("deadline.txt");
    fs::write(&timeout, b"owned").unwrap();
    assert_eq!(delete(&timeout, 1).unwrap_err().code, "ETIMEDOUT");
    let next = fixture.join("after-timeout");
    fs::write(&next, b"safe").unwrap();
    delete(&next, 30_000)?;
    // Timeouts are not transactional: the first child may already be removed.
    if timeout.exists() {
        delete(&timeout, 30_000)?;
    }
    Ok(())
}
