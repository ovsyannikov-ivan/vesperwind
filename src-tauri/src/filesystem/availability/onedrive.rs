//! Provider-neutral flags are classified only after a registered OneDrive root
//! has been confirmed. The native adapter never reads content during listing.
use super::{ContentAvailability, ContentAvailabilityStatus};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Membership {
    OneDrive,
    Unsupported,
    Unknown,
    InspectionError,
}

#[derive(Debug, Default)]
pub(crate) struct Facts {
    pub placeholder: bool,
    pub invalid: bool,
    pub in_sync: bool,
    pub partial: bool,
    pub partially_on_disk: bool,
    pub pinned: bool,
    pub unpinned: bool,
}

fn is_onedrive_registration(id: &str) -> bool {
    let mut parts = id.splitn(3, '!');
    parts
        .next()
        .is_some_and(|provider| provider.eq_ignore_ascii_case("OneDrive"))
        && parts.next().is_some_and(|sid| !sid.is_empty())
        && parts.next().is_some_and(|account| !account.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SyncState {
    InSync,
    NotInSync,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LocalContent {
    Present,
    NotFullyLocal,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSync {
    provider: &'static str,
    pub(crate) state: SyncState,
    pub(crate) local_content: LocalContent,
    pub(crate) inspection: &'static str,
    pin_policy: &'static str,
}

pub(crate) fn classify(
    membership: Membership,
    facts: &Facts,
) -> (Option<ContentAvailability>, Option<CloudSync>) {
    if matches!(membership, Membership::Unsupported | Membership::Unknown) {
        return (None, None);
    }
    if !facts.invalid && !facts.placeholder {
        // Newly created regular files in a registered root do not yet carry
        // placeholder evidence. Do not invent a pending upload state.
        return (None, None);
    }
    let failed = facts.invalid || membership == Membership::InspectionError;
    let status = if failed {
        Some(ContentAvailabilityStatus::Failed)
    } else if facts.partially_on_disk {
        Some(ContentAvailabilityStatus::Cloud)
    } else if facts.partial {
        Some(ContentAvailabilityStatus::NotReady)
    } else {
        None
    };
    let local_content = if failed {
        LocalContent::Unknown
    } else if facts.partially_on_disk {
        LocalContent::NotFullyLocal
    } else if facts.partial {
        LocalContent::Unknown
    } else {
        LocalContent::Present
    };
    (
        status.map(|status| ContentAvailability {
            status,
            provider: Some("onedrive"),
        }),
        Some(CloudSync {
            provider: "onedrive",
            state: if failed {
                SyncState::Unknown
            } else if facts.in_sync {
                SyncState::InSync
            } else {
                SyncState::NotInSync
            },
            local_content,
            inspection: if failed { "error" } else { "ok" },
            pin_policy: match (facts.pinned, facts.unpinned) {
                (true, false) => "pinned",
                (false, true) => "unpinned",
                _ => "unspecified",
            },
        }),
    )
}

#[cfg(target_os = "windows")]
pub(crate) mod native {
    use super::*;
    use crate::{
        error::NativeError,
        filesystem::{availability::Inspection, FileEntry, Filesystem},
    };
    use std::{
        ffi::OsString,
        fs,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
    };
    use windows::{
        core::{HRESULT, PCWSTR},
        Storage::Provider::StorageProviderSyncRootManager,
        Win32::{
            Foundation::{
                CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING,
                ERROR_NO_MORE_FILES, HANDLE,
            },
            Storage::{CloudFilters::*, FileSystem::*},
            System::{
                WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
                IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
            },
        },
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn error(path: &Path, native: windows::core::Error) -> NativeError {
        let (code, message) = if native.code()
            == HRESULT::from_win32(
                windows::Win32::Foundation::ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE.0,
            ) {
            (
                "ECLOUD_OFFLINE",
                "OneDrive content is not available offline",
            )
        } else if native.code()
            == HRESULT::from_win32(
                windows::Win32::Foundation::ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING.0,
            )
        {
            (
                "ECLOUD_PROVIDER_UNAVAILABLE",
                "OneDrive is not running or is unavailable",
            )
        } else if native.code()
            == HRESULT::from_win32(windows::Win32::Foundation::ERROR_ACCESS_DENIED.0)
        {
            ("EFILE_PERMISSION", "Permission denied")
        } else {
            (
                "ECLOUD_IO",
                "Unable to inspect or download OneDrive content",
            )
        };
        NativeError::new(code, message)
            .with_path(path)
            .with_native_error(format!("HRESULT={:#010x}: {native}", native.code().0))
    }

    fn directory_error(path: &Path, native: windows::core::Error) -> NativeError {
        // Preserve the existing listing error contract for ordinary folders.
        let code = native.code().0 as u32;
        let io = if code & 0xffff0000 == 0x80070000 {
            std::io::Error::from_raw_os_error((code & 0xffff) as i32)
        } else {
            std::io::Error::other(native.to_string())
        };
        crate::filesystem::filesystem_error(
            &io,
            &path.to_string_lossy(),
            "Unable to read this folder",
        )
    }
    struct Apartment(bool);
    impl Apartment {
        fn enter() -> windows::core::Result<Self> {
            // SAFETY: Balanced initialization on this blocking worker thread.
            match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                Ok(()) => Ok(Self(true)),
                Err(e) if e.code() == HRESULT(0x80010106u32 as i32) => Ok(Self(false)),
                Err(e) => Err(e),
            }
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { RoUninitialize() };
            }
        }
    }

    pub(crate) fn registered_roots() -> windows::core::Result<Vec<PathBuf>> {
        let _apartment = Apartment::enter()?;
        let roots = StorageProviderSyncRootManager::GetCurrentSyncRoots()?;
        let mut result = Vec::new();
        for i in 0..roots.Size()? {
            let root = roots.GetAt(i)?;
            let id = root.Id()?.to_string();
            // The documented ID is provider!SID!account, not a folder name.
            if is_onedrive_registration(&id) {
                result.push(PathBuf::from(root.Path()?.Path()?.to_string()));
            }
        }
        Ok(result)
    }

    fn normalized(path: &Path) -> String {
        let value = path.to_string_lossy().replace('/', "\\");
        value
            .strip_prefix("\\\\?\\")
            .unwrap_or(&value)
            .trim_end_matches('\\')
            .to_lowercase()
    }
    fn contains(root: &Path, path: &Path) -> bool {
        let root = normalized(root);
        let path = normalized(path);
        path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with('\\'))
    }

    fn membership(path: &Path, roots: &[PathBuf]) -> Membership {
        if !roots.iter().any(|root| contains(root, path)) {
            return Membership::Unsupported;
        }
        let path = wide(path);
        let mut info = CF_SYNC_ROOT_PROVIDER_INFO::default();
        // SAFETY: Fixed-size native output, valid NUL-terminated path. This
        // queries registration only and never opens data or initiates hydration.
        match unsafe {
            CfGetSyncRootInfoByPath(
                PCWSTR(path.as_ptr()),
                CF_SYNC_ROOT_INFO_PROVIDER,
                (&mut info as *mut CF_SYNC_ROOT_PROVIDER_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
                None,
            )
        } {
            Ok(()) => Membership::OneDrive,
            Err(_) => Membership::InspectionError,
        }
    }

    fn facts(data: &WIN32_FIND_DATAW) -> Facts {
        // AttributeTag avoids the ANSI-only pointer exposed by the FindData
        // binding. Both values come directly from Unicode enumeration metadata.
        let state = unsafe {
            CfGetPlaceholderStateFromAttributeTag(data.dwFileAttributes, data.dwReserved0)
        };
        Facts {
            invalid: state == CF_PLACEHOLDER_STATE_INVALID,
            placeholder: state.contains(CF_PLACEHOLDER_STATE_PLACEHOLDER),
            in_sync: state.contains(CF_PLACEHOLDER_STATE_IN_SYNC),
            partial: state.contains(CF_PLACEHOLDER_STATE_PARTIAL),
            partially_on_disk: state.contains(CF_PLACEHOLDER_STATE_PARTIALLY_ON_DISK),
            pinned: data.dwFileAttributes & FILE_ATTRIBUTE_PINNED.0 != 0,
            unpinned: data.dwFileAttributes & FILE_ATTRIBUTE_UNPINNED.0 != 0,
        }
    }

    struct FindHandle(HANDLE);
    impl Drop for FindHandle {
        fn drop(&mut self) {
            let _ = unsafe { FindClose(self.0) };
        }
    }

    // Public compatibility API documented by Microsoft's Cloud Files guide:
    // https://learn.microsoft.com/windows/win32/cfapi/build-a-cloud-file-sync-engine
    // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-rtlsetthreadplaceholdercompatibilitymode
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlSetThreadPlaceholderCompatibilityMode(mode: i8) -> i8;
    }
    struct PlaceholderExposure {
        previous: i8,
        _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
    }
    impl PlaceholderExposure {
        fn enter() -> windows::core::Result<Self> {
            // SAFETY: A documented CHAR value, affecting this worker thread
            // only. The !Send guard restores the mode on the same thread.
            let previous = unsafe { RtlSetThreadPlaceholderCompatibilityMode(2) };
            if previous < 0 {
                return Err(windows::core::Error::from_hresult(HRESULT(
                    0x80004005u32 as i32,
                )));
            }
            Ok(Self {
                previous,
                _thread_bound: std::marker::PhantomData,
            })
        }
    }
    impl Drop for PlaceholderExposure {
        fn drop(&mut self) {
            unsafe { RtlSetThreadPlaceholderCompatibilityMode(self.previous) };
        }
    }

    pub(crate) fn list_directory(
        filesystem: &Filesystem,
        real: &Path,
        logical: &Path,
    ) -> Result<Vec<FileEntry>, NativeError> {
        let _exposure = PlaceholderExposure::enter().map_err(|e| error(real, e))?;
        // One registration snapshot and one root query per listing. There is
        // no provider process, per-entry handle, background timer or root cache.
        let membership = match registered_roots() {
            Ok(roots) => membership(real, &roots),
            Err(_) => Membership::Unknown,
        };
        let pattern = wide(&real.join("*"));
        let mut data = WIN32_FIND_DATAW::default();
        let handle = match unsafe { FindFirstFileW(PCWSTR(pattern.as_ptr()), &mut data) } {
            Ok(handle) => FindHandle(handle),
            Err(e) if e.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) => {
                return Ok(Vec::new())
            }
            Err(e) => return Err(directory_error(logical, e)),
        };
        let mut entries = Vec::new();
        loop {
            let length = data
                .cFileName
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(data.cFileName.len());
            let name = OsString::from_wide(&data.cFileName[..length]);
            if name != "." && name != ".." {
                let mut entry = crate::filesystem::entry_from_path(
                    filesystem,
                    real.join(&name),
                    logical.join(&name),
                    name,
                );
                if !entry.is_directory && !entry.is_symbolic_link && entry.metadata_error.is_none()
                {
                    let (availability, sync) = classify(membership, &facts(&data));
                    entry.content_availability = availability;
                    entry.cloud_sync = sync;
                }
                entries.push(entry);
            }
            match unsafe { FindNextFileW(handle.0, &mut data) } {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0) => break,
                Err(e) => return Err(directory_error(logical, e)),
            }
        }
        Ok(entries)
    }

    pub(crate) fn inspect_passive(
        path: &Path,
    ) -> Result<(Option<super::ContentAvailability>, Option<super::CloudSync>), NativeError> {
        let data = find_data(path)?;
        let roots = registered_roots().map_err(|e| error(path, e))?;
        let membership = membership(path, &roots);
        Ok(classify(membership, &facts(&data)))
    }

    fn find_data(path: &Path) -> Result<WIN32_FIND_DATAW, NativeError> {
        let _exposure = PlaceholderExposure::enter().map_err(|e| error(path, e))?;
        let path_wide = wide(path);
        let mut data = WIN32_FIND_DATAW::default();
        let _handle = FindHandle(
            unsafe { FindFirstFileW(PCWSTR(path_wide.as_ptr()), &mut data) }
                .map_err(|e| error(path, e))?,
        );
        Ok(data)
    }

    struct FileHandle(HANDLE);
    impl Drop for FileHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    // Handles have no thread affinity; all access to pending I/O is serialized
    // by Hydration's mutex. No WinRT apartment object escapes its worker.
    unsafe impl Send for FileHandle {}

    fn open_attributes(path: &Path, asynchronous: bool) -> Result<FileHandle, NativeError> {
        let value = wide(path);
        let flags = if asynchronous {
            FILE_FLAG_OVERLAPPED
        } else {
            FILE_FLAGS_AND_ATTRIBUTES(0)
        };
        // SAFETY: NUL-terminated path; metadata-only access and share-all modes.
        unsafe {
            CreateFileW(
                PCWSTR(value.as_ptr()),
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                flags,
                None,
            )
        }
        .map(FileHandle)
        .map_err(|e| error(path, e))
    }

    pub(crate) fn inspect_preparing(
        path: &Path,
        _metadata: &fs::Metadata,
    ) -> Result<Option<Inspection>, NativeError> {
        let data = find_data(path)?;
        let facts = facts(&data);
        if !facts.placeholder && !facts.invalid {
            return Ok(None);
        }
        let roots = registered_roots().map_err(|e| error(path, e))?;
        match membership(path, &roots) {
            Membership::Unsupported | Membership::Unknown => return Ok(None),
            Membership::InspectionError => {
                return Err(NativeError::new(
                    "ECLOUD_METADATA",
                    "Unable to inspect the OneDrive sync root",
                )
                .with_path(path))
            }
            Membership::OneDrive => {}
        }
        if facts.invalid {
            return Err(NativeError::new(
                "ECLOUD_METADATA",
                "Invalid OneDrive placeholder metadata",
            )
            .with_path(path));
        }
        if !facts.partial && !facts.partially_on_disk {
            return Ok(None);
        }
        let handle = open_attributes(path, false)?;
        // Enough aligned space for the documented maximum 4KB file identity.
        let mut buffer =
            vec![0u64; (std::mem::size_of::<CF_PLACEHOLDER_STANDARD_INFO>() + 4096).div_ceil(8)];
        unsafe {
            CfGetPlaceholderInfo(
                handle.0,
                CF_PLACEHOLDER_INFO_STANDARD,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                None,
            )
        }
        .map_err(|e| error(path, e))?;
        let info = unsafe { &*buffer.as_ptr().cast::<CF_PLACEHOLDER_STANDARD_INFO>() };
        Ok(Some(Inspection::NotAvailable {
            progress: None, // allocated on-disk bytes are an activity marker, not a guessed percentage
            activity_marker: u64::try_from(info.OnDiskDataSize).ok(),
        }))
    }

    struct Pending {
        handle: FileHandle,
        overlapped: Box<OVERLAPPED>,
        complete: bool,
    }
    // OVERLAPPED is heap allocated, stays at a stable address until completion,
    // and is only accessed while holding Hydration's mutex.
    unsafe impl Send for Pending {}
    impl Pending {
        fn finish(&mut self, wait: bool) -> windows::core::Result<bool> {
            if self.complete {
                return Ok(true);
            }
            let mut transferred = 0;
            match unsafe {
                GetOverlappedResult(self.handle.0, &*self.overlapped, &mut transferred, wait)
            } {
                Ok(()) => {
                    self.complete = true;
                    Ok(true)
                }
                Err(e) if !wait && e.code() == HRESULT::from_win32(ERROR_IO_INCOMPLETE.0) => {
                    Ok(false)
                }
                Err(e) => {
                    self.complete = true;
                    Err(e)
                }
            }
        }
    }
    impl Drop for Pending {
        fn drop(&mut self) {
            if !self.complete {
                // Cancel only our overlapped request; drain it before releasing
                // kernel-visible storage. Never change pinning or provider sync.
                let _ = unsafe { CancelIoEx(self.handle.0, Some(&*self.overlapped)) };
                let _ = self.finish(true);
            }
        }
    }
    pub(crate) struct Hydration {
        path: PathBuf,
        pending: Mutex<Pending>,
    }
    impl std::fmt::Debug for Hydration {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Hydration").finish_non_exhaustive()
        }
    }
    impl Hydration {
        pub(crate) fn start(path: &Path) -> Result<Arc<Self>, NativeError> {
            let handle = open_attributes(path, true)?;
            let mut pending = Pending {
                handle,
                overlapped: Box::default(),
                complete: true,
            };
            match unsafe {
                CfHydratePlaceholder(
                    pending.handle.0,
                    0,
                    -1,
                    CF_HYDRATE_FLAG_NONE,
                    Some(&mut *pending.overlapped),
                )
            } {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_IO_PENDING.0) => {
                    pending.complete = false
                }
                Err(e) => return Err(error(path, e)),
            }
            Ok(Arc::new(Self {
                path: path.to_path_buf(),
                pending: Mutex::new(pending),
            }))
        }
        pub(crate) fn status(&self) -> Result<bool, NativeError> {
            self.pending
                .lock()
                .unwrap()
                .finish(false)
                .map_err(|e| error(&self.path, e))
        }
        pub(crate) fn wait(&self) -> Result<(), NativeError> {
            self.pending
                .lock()
                .unwrap()
                .finish(true)
                .map(|_| ())
                .map_err(|e| error(&self.path, e))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::fs::MetadataExt;
        #[test]
        fn ordinary_directory_errors_keep_the_filesystem_contract() {
            for (native, expected) in [
                (windows::Win32::Foundation::ERROR_ACCESS_DENIED.0, "EACCES"),
                (windows::Win32::Foundation::ERROR_PATH_NOT_FOUND.0, "ENOENT"),
            ] {
                let result = directory_error(
                    Path::new("C:\\fixture"),
                    windows::core::Error::from_hresult(HRESULT::from_win32(native)),
                );
                assert_eq!(result.code, expected);
            }
        }
        #[test]
        fn placeholder_exposure_is_scoped_to_the_worker_and_restored() {
            let before = unsafe { RtlSetThreadPlaceholderCompatibilityMode(0) };
            assert!(before >= 0);
            unsafe { RtlSetThreadPlaceholderCompatibilityMode(before) };
            {
                let _guard = PlaceholderExposure::enter().unwrap();
                let mode = unsafe { RtlSetThreadPlaceholderCompatibilityMode(2) };
                assert_eq!(mode, 2);
            }
            let after = unsafe { RtlSetThreadPlaceholderCompatibilityMode(before) };
            assert_eq!(after, before);
        }

        #[test]
        #[ignore = "opt-in explicit hydration of disposable OneDrive fixtures only"]
        fn diagnose_synthetic_preparation() {
            use crate::{content::ContentManager, filesystem::availability::AvailabilityState};
            use notify::{RecursiveMode, Watcher};
            let path = PathBuf::from(
                std::env::var("VESPERWIND_ONEDRIVE_FIXTURE_FILE")
                    .expect("set a synthetic fixture file"),
            );
            let directory = path.parent().unwrap();
            assert!(directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("vesperwind-availability-"));
            assert!(matches!(
                path.file_name().unwrap().to_str(),
                Some("small.txt" | "large.bin")
            ));
            assert_eq!(
                membership(directory, &registered_roots().unwrap()),
                Membership::OneDrive
            );
            let filesystem = Filesystem::from_root(directory, directory.to_path_buf()).unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut watcher = notify::recommended_watcher(move |event| {
                let _ = sender.send(event);
            })
            .unwrap();
            watcher
                .watch(directory, RecursiveMode::NonRecursive)
                .unwrap();
            let manager = ContentManager::new();
            let start = std::time::Instant::now();
            let mut preparation = manager
                .prepare(&filesystem, Some("local"), &path.to_string_lossy())
                .unwrap();
            if std::env::var_os("VESPERWIND_ONEDRIVE_CANCEL_FIRST").is_some() {
                if let Some(id) = preparation.operation_id.as_deref() {
                    assert!(manager.cancel(id));
                    eprintln!("first_preparation_cancelled=true");
                    preparation = manager
                        .prepare(&filesystem, Some("local"), &path.to_string_lossy())
                        .unwrap();
                }
            }
            eprintln!(
                "initial_preparation={}",
                serde_json::to_string(&preparation).unwrap()
            );
            eprintln!(
                "active_listing={}",
                serde_json::to_string(
                    &manager.annotate_listing(
                        filesystem
                            .list_directory(&directory.to_string_lossy())
                            .unwrap()
                    )
                )
                .unwrap()
            );
            while preparation.state == AvailabilityState::Materializing {
                assert!(
                    start.elapsed() < std::time::Duration::from_secs(90),
                    "explicit hydration timed out"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
                preparation = manager
                    .status(&filesystem, preparation.operation_id.as_deref().unwrap())
                    .unwrap();
            }
            assert_eq!(preparation.state, AvailabilityState::Ready);
            let bytes = fs::read(&path).unwrap();
            if path.file_name().unwrap() == "large.bin" {
                assert_eq!(bytes.len(), 16777216);
                assert!(bytes.iter().all(|value| *value == 0));
            } else {
                assert!(bytes.starts_with(b"Vesperwind synthetic OneDrive availability fixture."));
            }
            eprintln!(
                "final_preparation={} verified_bytes={} watcher_events={}",
                serde_json::to_string(&preparation).unwrap(),
                bytes.len(),
                receiver.try_iter().count()
            );
            eprintln!(
                "final_listing={}",
                serde_json::to_string(
                    &filesystem
                        .list_directory(&directory.to_string_lossy())
                        .unwrap()
                )
                .unwrap()
            );
            if std::env::var_os("VESPERWIND_ONEDRIVE_MODIFY_FIXTURE").is_some() {
                assert_eq!(path.file_name().unwrap(), "small.txt");
                fs::write(
                    &path,
                    b"Vesperwind synthetic OneDrive availability fixture. Locally modified.",
                )
                .unwrap();
                eprintln!(
                    "modified_listing={}",
                    serde_json::to_string(
                        &filesystem
                            .list_directory(&directory.to_string_lossy())
                            .unwrap()
                    )
                    .unwrap()
                );
            }
        }
        #[test]
        fn root_matching_is_case_insensitive_and_respects_component_boundaries() {
            assert!(contains(
                Path::new("C:\\Cloud"),
                Path::new("\\\\?\\C:\\CLOUD\\Report.pdf")
            ));
            assert!(!contains(
                Path::new("C:\\Cloud"),
                Path::new("C:\\CloudOther\\Report.pdf")
            ));
        }
        #[test]
        #[ignore = "opt-in metadata-only diagnostics for registered OneDrive roots"]
        fn diagnose_registered_roots_and_passive_listing() {
            let _exposure = PlaceholderExposure::enter().unwrap();
            let roots = registered_roots().unwrap();
            eprintln!("registered_onedrive_roots={}", roots.len());
            if let Ok(output) = std::env::var("VESPERWIND_DIAGNOSE_ROOTS_OUTPUT") {
                fs::write(output, serde_json::to_vec(&roots).unwrap()).unwrap();
            }
            let Ok(directory) = std::env::var("VESPERWIND_DIAGNOSE_LIST_DIRECTORY") else {
                return;
            };
            let filesystem = Filesystem::desktop(
                crate::filesystem::paths::absolute_clean(Path::new(&directory)).unwrap(),
            )
            .unwrap();
            let before = fs::read_dir(&directory)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (e.file_name(), e.metadata().unwrap().file_attributes())
                })
                .collect::<std::collections::BTreeMap<_, _>>();
            let started = std::time::Instant::now();
            let entries = filesystem.list_directory(&directory).unwrap();
            eprintln!("membership={:?}", membership(Path::new(&directory), &roots));
            for entry in &entries {
                let data = find_data(Path::new(&entry.path)).unwrap();
                eprintln!(
                    "entry={} attrs={:#x} tag={:#x} facts={:?}",
                    entry.name,
                    data.dwFileAttributes,
                    data.dwReserved0,
                    facts(&data)
                );
            }
            eprintln!(
                "entries={} elapsed_ms={} metadata={}",
                entries.len(),
                started.elapsed().as_millis(),
                serde_json::to_string(&entries).unwrap()
            );
            let after = fs::read_dir(&directory)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (e.file_name(), e.metadata().unwrap().file_attributes())
                })
                .collect::<std::collections::BTreeMap<_, _>>();
            assert_eq!(before, after, "passive listing must not hydrate files");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_registration_supports_personal_and_business_without_path_guesses() {
        assert!(is_onedrive_registration(
            "OneDrive!S-1-5-21-fixture!Personal"
        ));
        assert!(is_onedrive_registration(
            "OneDrive!S-1-5-21-fixture!Business1"
        ));
        for id in [
            "OneDrive",
            "OneDrive!!Personal",
            "OneDrive!S-1!",
            "OneDriveBackup!S-1!Personal",
            "Dropbox!S-1!OneDrive",
            "C:\\OneDrive\\Report.pdf",
        ] {
            assert!(!is_onedrive_registration(id));
        }
    }
    #[test]
    fn ordinary_unsupported_and_unknown_entries_never_gain_cloud_states() {
        for membership in [
            Membership::OneDrive,
            Membership::Unsupported,
            Membership::Unknown,
            Membership::InspectionError,
        ] {
            let (availability, sync) = classify(membership, &Facts::default());
            assert!(availability.is_none() && sync.is_none());
        }
        for membership in [Membership::Unsupported, Membership::Unknown] {
            let (availability, sync) = classify(
                membership,
                &Facts {
                    placeholder: true,
                    partially_on_disk: true,
                    in_sync: true,
                    ..Facts::default()
                },
            );
            assert!(availability.is_none() && sync.is_none());
        }
    }
    #[test]
    fn local_presence_sync_and_pinning_are_independent() {
        for in_sync in [false, true] {
            for missing in [false, true] {
                for pinned in [false, true] {
                    let (availability, sync) = classify(
                        Membership::OneDrive,
                        &Facts {
                            placeholder: true,
                            partial: missing,
                            partially_on_disk: missing,
                            in_sync,
                            pinned,
                            ..Facts::default()
                        },
                    );
                    let sync = sync.unwrap();
                    assert_eq!(
                        sync.state,
                        if in_sync {
                            SyncState::InSync
                        } else {
                            SyncState::NotInSync
                        }
                    );
                    assert_eq!(
                        sync.local_content,
                        if missing {
                            LocalContent::NotFullyLocal
                        } else {
                            LocalContent::Present
                        }
                    );
                    assert_eq!(availability.is_some(), missing);
                    if missing {
                        assert_eq!(
                            serde_json::to_value(availability).unwrap(),
                            json!({"state":"cloud","provider":"onedrive"})
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn partial_without_missing_bytes_requires_validation_not_a_download_claim() {
        let (availability, sync) = classify(
            Membership::OneDrive,
            &Facts {
                placeholder: true,
                partial: true,
                in_sync: true,
                ..Facts::default()
            },
        );
        assert_eq!(
            serde_json::to_value(availability).unwrap(),
            json!({"state":"notReady","provider":"onedrive"})
        );
        assert_eq!(sync.unwrap().local_content, LocalContent::Unknown);
    }
    #[test]
    fn invalid_and_inspection_errors_cannot_confirm_sync_or_local_bytes() {
        for (membership, invalid) in [
            (Membership::OneDrive, true),
            (Membership::InspectionError, false),
        ] {
            let (availability, sync) = classify(
                membership,
                &Facts {
                    placeholder: true,
                    in_sync: true,
                    invalid,
                    ..Facts::default()
                },
            );
            assert_eq!(
                serde_json::to_value(availability).unwrap(),
                json!({"state":"failed","provider":"onedrive"})
            );
            let sync = sync.unwrap();
            assert_eq!(sync.state, SyncState::Unknown);
            assert_eq!(sync.local_content, LocalContent::Unknown);
            assert_eq!(sync.inspection, "error");
        }
    }
}
