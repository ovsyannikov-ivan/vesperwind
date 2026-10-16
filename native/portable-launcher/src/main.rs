#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod package;
use package::{check_regular, list_files, Package, Result};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(not(test))]
static PAYLOAD: &[u8] = include_bytes!(env!("PORTABLE_PAYLOAD"));
#[cfg(test)]
static PAYLOAD: &[u8] = &[];

#[derive(Default)]
struct Options {
    cache: Option<PathBuf>,
    data: Option<PathBuf>,
    report: Option<PathBuf>,
    extract: Option<PathBuf>,
    verify: bool,
    args: Vec<OsString>,
}
fn options(args: impl IntoIterator<Item = OsString>) -> Result<Options> {
    let mut result = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let target = match arg.to_str() {
            Some("--portable-cache-dir") => Some(&mut result.cache),
            Some("--portable-data-dir") => Some(&mut result.data),
            Some("--portable-report") => Some(&mut result.report),
            Some("--portable-extract") => Some(&mut result.extract),
            Some("--portable-verify") => {
                result.verify = true;
                None
            }
            Some("--") => {
                result.args.extend(args);
                break;
            }
            Some(value) if value.starts_with("--portable-") => {
                return Err(format!("Unknown portable option: {value}").into())
            }
            _ => {
                result.args.push(arg);
                None
            }
        };
        if let Some(target) = target {
            let path = PathBuf::from(args.next().ok_or("Portable option requires a path")?);
            if !path.is_absolute() {
                return Err("Portable option paths must be absolute".into());
            }
            if target.replace(path).is_some() {
                return Err("Duplicate portable option".into());
            }
        }
    }
    Ok(result)
}

fn directory(path: &Path) -> Result<PathBuf> {
    fs::create_dir_all(path)?;
    check_regular(path, true)?;
    Ok(fs::canonicalize(path)?)
}
fn lock_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    check_regular(path, false)?;
    Ok(file)
}
/// Only remove a generated immediate child after checking its entire tree for links.
fn remove_tree(parent: &Path, name: &str) -> Result<()> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid generated cache name".into());
    }
    let path = parent.join(name);
    if path.try_exists()? {
        list_files(&path)?;
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn runtime_permissions(root: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let runtime = root.join("vendor/webview2");
        if runtime.exists() {
            let system = std::env::var_os("SystemRoot").ok_or("SystemRoot is unavailable")?;
            let result = Command::new(PathBuf::from(system).join("System32/icacls.exe"))
                .arg(&runtime)
                .args([
                    "/grant",
                    "*S-1-15-2-2:(OI)(CI)(RX)",
                    "*S-1-15-2-1:(OI)(CI)(RX)",
                ])
                .creation_flags(0x08000000)
                .output()?;
            if !result.status.success() {
                return Err(format!(
                    "Cannot grant WebView2 runtime read access: {}",
                    String::from_utf8_lossy(&result.stderr)
                )
                .into());
            }
        }
    }
    #[cfg(not(windows))]
    let _ = root;
    Ok(())
}

struct Prepared {
    root: PathBuf,
    reused: bool,
    _lease: File,
}
fn prepare(package: &Package, cache: &Path) -> Result<Prepared> {
    let cache = directory(cache)?;
    let locks = directory(&cache.join("locks"))?;
    let bundles = directory(&cache.join("bundles"))?;
    let staging = directory(&cache.join("staging"))?;
    let guard = lock_file(&cache.join("prepare.lock"))?;
    guard.lock()?;
    let lease = lock_file(&locks.join(&package.id))?;
    lease.lock_shared()?;
    let root = bundles.join(&package.id);
    let reused = package.verify(&root).is_ok();
    if !reused {
        lease.unlock()?;
        lease.try_lock().map_err(|_| {
            "The damaged runtime is in use; close this build before repairing its cache"
        })?;
        remove_tree(&bundles, &package.id)?;
        remove_tree(&staging, &package.id)?;
        let pending = staging.join(&package.id);
        package.extract(&pending)?;
        runtime_permissions(&pending)?;
        fs::rename(&pending, &root)?;
        lease.unlock()?;
        lease.lock_shared()?;
    }
    // Retain the current and two most recently used older builds. Never delete an active build.
    let mut old = fs::read_dir(&bundles)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name != package.id && name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
        })
        .collect::<Vec<_>>();
    old.sort_by_key(|entry| {
        std::cmp::Reverse(
            fs::metadata(locks.join(entry.file_name()))
                .and_then(|m| m.modified())
                .ok(),
        )
    });
    for entry in old.into_iter().skip(2) {
        let old_lease = lock_file(&locks.join(entry.file_name()))?;
        if old_lease.try_lock().is_ok() {
            // Antivirus and a retiring WebView2 child can briefly hold old files
            // after the host exits. Housekeeping must not prevent a healthy launch.
            if let Err(error) = remove_tree(&bundles, &entry.file_name().to_string_lossy()) {
                eprintln!("Deferred old runtime cleanup: {error}");
            }
        }
    }
    // Touch only the lock file, leaving the verified resource tree immutable.
    lease.set_modified(std::time::SystemTime::now())?;
    drop(guard);
    Ok(Prepared {
        root,
        reused,
        _lease: lease,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    schema: u32,
    bundle_id: &'a str,
    version: &'a str,
    cache_reused: bool,
    runtime_dir: &'a Path,
    data_dir: &'a Path,
    files_verified: usize,
}
fn write_report(report: &Report, output: Option<&Path>) -> Result<()> {
    let json = serde_json::to_string_pretty(report)?;
    if let Some(path) = output {
        fs::write(path, &json)?;
    }
    println!("{json}");
    Ok(())
}

fn run() -> Result<i32> {
    let options = options(std::env::args_os().skip(1))?;
    let package = Package::open(PAYLOAD, env!("PORTABLE_SHA256"))?;
    if let Some(destination) = options.extract {
        package.extract(&destination)?;
        runtime_permissions(&destination)?;
        return Ok(0);
    }
    let executable = std::env::current_exe()?;
    let parent = executable
        .parent()
        .ok_or("Executable has no parent directory")?;
    let data = directory(
        &options
            .data
            .unwrap_or_else(|| parent.join("Vesperwind.data")),
    )?;
    // Fail visibly on a read-only folder instead of silently using the installed profile.
    let probe = data.join(format!(".write-probe-{}", std::process::id()));
    drop(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?,
    );
    fs::remove_file(probe)?;
    let cache = match options.cache {
        Some(path) => path,
        None => PathBuf::from(
            std::env::var_os("LOCALAPPDATA")
                .ok_or("LOCALAPPDATA is unavailable; use --portable-cache-dir")?,
        )
        .join("Vesperwind/portable-cache"),
    };
    let cache = directory(&cache)?;
    if data.starts_with(&cache) {
        return Err("Portable data must be outside the resource cache; cache repair must never remove user data".into());
    }
    let prepared = prepare(&package, &cache)?;
    write_report(
        &Report {
            schema: 1,
            bundle_id: &package.id,
            version: &package.manifest.version,
            cache_reused: prepared.reused,
            runtime_dir: &prepared.root,
            data_dir: &data,
            files_verified: package.manifest.files.len(),
        },
        options.report.as_deref(),
    )?;
    if options.verify {
        return Ok(0);
    }
    let mut child = Command::new(prepared.root.join("vesperwind.exe"));
    child
        .args(options.args)
        .env("VESPERWIND_PORTABLE_DATA_DIR", &data)
        .env("VESPERWIND_PORTABLE_LAUNCHER", &executable)
        .env(
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            prepared.root.join("vendor/webview2"),
        )
        .env("WEBVIEW2_USER_DATA_FOLDER", data.join("webview"))
        .env_remove("VESPERWIND_LIBMPV_PATH")
        .env_remove("VESPERWIND_SETTINGS_PATH");
    // Stay alive and hold the shared cache lease for the entire app lifetime.
    let status = child.status()?;
    if !status.success() {
        return Err(format!("The application exited unsuccessfully ({status}). Run with --portable-report to collect resolved runtime paths.").into());
    }
    Ok(0)
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            let message = format!("Vesperwind Portable could not start.\n\n{error}");
            eprintln!("{message}");
            // CI and verification commands use exit codes; ordinary GUI startup needs a visible error.
            if !std::env::args_os().any(|a| {
                a == "--portable-verify" || a == "--portable-extract" || a == "--portable-report"
            }) {
                #[cfg(windows)]
                unsafe {
                    let text = message.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
                    let title = "Vesperwind Portable\0".encode_utf16().collect::<Vec<_>>();
                    windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                        std::ptr::null_mut(),
                        text.as_ptr(),
                        title.as_ptr(),
                        0x10,
                    );
                }
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn options_preserve_application_arguments_and_require_absolute_paths() {
        let opts = options(
            ["--portable-verify", "--", "--native-regression", "fixture"].map(OsString::from),
        )
        .unwrap();
        assert!(opts.verify);
        assert_eq!(opts.args, ["--native-regression", "fixture"]);
        assert!(options(["--portable-data-dir", "relative"].map(OsString::from)).is_err());
        assert!(options(["--portable-data-dir"].map(OsString::from)).is_err());
        assert!(options(["--portable-typo"].map(OsString::from)).is_err());
    }
    #[test]
    fn cache_deletion_rejects_non_generated_names() {
        for name in ["..", "../data", "C:/", "settings", ""] {
            assert!(remove_tree(Path::new("."), name).is_err());
        }
    }

    fn fixture_cache(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vesper-cache-{}-{label}", std::process::id()))
    }

    #[test]
    fn cache_reuses_resources_and_repairs_corruption_after_lease_release() {
        let bytes = package::tests::fixture(vec![("app.exe", b"original")]);
        let package = Package::open(&bytes, &package::digest(&bytes)).unwrap();
        let cache = fixture_cache("repair");
        let first = prepare(&package, &cache).unwrap();
        assert!(!first.reused);
        let second = prepare(&package, &cache).unwrap();
        assert!(second.reused);
        fs::write(first.root.join("app.exe"), b"tampered").unwrap();
        assert!(
            prepare(&package, &cache).is_err(),
            "active runtime must not be deleted"
        );
        drop(first);
        drop(second);
        let repaired = prepare(&package, &cache).unwrap();
        assert!(!repaired.reused);
        package.verify(&repaired.root).unwrap();
        drop(repaired);
        fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn interrupted_staging_is_replaced_without_touching_user_data() {
        let bytes = package::tests::fixture(vec![("app.exe", b"original")]);
        let package = Package::open(&bytes, &package::digest(&bytes)).unwrap();
        let cache = fixture_cache("interrupted");
        let pending = cache.join("staging").join(&package.id);
        fs::create_dir_all(&pending).unwrap();
        fs::write(pending.join("partial"), b"partial").unwrap();
        fs::write(cache.join("settings.json"), b"preserved").unwrap();
        let prepared = prepare(&package, &cache).unwrap();
        assert!(!prepared.reused);
        assert!(!pending.exists());
        assert_eq!(fs::read(cache.join("settings.json")).unwrap(), b"preserved");
        drop(prepared);
        fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn concurrent_starts_publish_one_complete_bundle() {
        let bytes = std::sync::Arc::new(package::tests::fixture(vec![("app.exe", b"original")]));
        let cache = fixture_cache("concurrent");
        let threads = (0..4)
            .map(|_| {
                let bytes = bytes.clone();
                let cache = cache.clone();
                std::thread::spawn(move || {
                    let package = Package::open(&bytes, &package::digest(&bytes)).unwrap();
                    let prepared = prepare(&package, &cache).unwrap();
                    package.verify(&prepared.root).unwrap();
                    prepared.reused
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|t| (!t.join().unwrap()).then_some(()))
                .count(),
            1
        );
        fs::remove_dir_all(cache).unwrap();
    }

    #[test]
    fn pruning_retains_live_older_builds_until_their_lease_is_released() {
        let cache = fixture_cache("pruning");
        let first_bytes = package::tests::fixture(vec![("app.exe", b"first")]);
        let first_package = Package::open(&first_bytes, &package::digest(&first_bytes)).unwrap();
        let first = prepare(&first_package, &cache).unwrap();
        for content in [b"second".as_slice(), b"third", b"fourth"] {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let bytes = package::tests::fixture(vec![("app.exe", content)]);
            let package = Package::open(&bytes, &package::digest(&bytes)).unwrap();
            drop(prepare(&package, &cache).unwrap());
        }
        assert!(first.root.exists());
        let first_root = first.root.clone();
        drop(first);
        let bytes = package::tests::fixture(vec![("app.exe", b"fourth")]);
        let package = Package::open(&bytes, &package::digest(&bytes)).unwrap();
        drop(prepare(&package, &cache).unwrap());
        assert!(!first_root.exists());
        fs::remove_dir_all(cache).unwrap();
    }
}
