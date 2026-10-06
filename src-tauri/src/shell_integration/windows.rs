//! Windows Shell/OLE integration.
//!
//! * One `IDataObject` serves both the clipboard and outbound drag and drop:
//!   local items as `CF_HDROP`; selections with remote (SFTP) items as virtual
//!   files (`FileGroupDescriptorW` + `FileContents`/`IStream`), streamed from
//!   the provider on demand. Nothing is downloaded before Explorer reads.
//! * Clipboard objects live on a dedicated STA thread with its own message
//!   loop, so Explorer's calls never wait for the UI thread.
//! * Content streams are created in the MTA and handed out as proxies, so
//!   Explorer's `IStream::Read` calls run on RPC threads instead of the STA
//!   that owns the data object (UI thread during drag and drop).
//! * Explorer files dropped onto the WebView arrive as HTML5 File objects;
//!   WebView2 `postMessageWithAdditionalObjects` gives the host their paths.
//!
//! All `unsafe` is FFI with the invariants stated next to it.
#![allow(non_snake_case)]

use super::{
    clipboard::{ClipboardFileRef, ClipboardOperation, ClipboardPayload, SystemClipboard},
    emit,
    transfer::{self, ProviderFiles, RemoteFiles, TreeEntry},
    DragItem,
};
use crate::error::NativeError;
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::{
    core::{implement, Interface, BOOL, HRESULT, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            GlobalFree, DATA_S_SAMEFORMATETC, DV_E_FORMATETC, DV_E_LINDEX, DV_E_TYMED, E_FAIL,
            E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY, FILETIME, HGLOBAL, HWND, LPARAM,
            OLE_E_ADVISENOTSUPPORTED, POINT, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION,
            STG_E_READFAULT, S_FALSE, S_OK, WPARAM,
        },
        Graphics::Gdi::ScreenToClient,
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        System::{
            Com::{
                CoInitializeEx, CoTaskMemAlloc, IAdviseSink, IBindCtx, IDataObject,
                IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream,
                IStream_Impl, Marshal::CoMarshalInterThreadInterfaceInStream,
                StructuredStorage::CoGetInterfaceAndReleaseStream, COINIT_MULTITHREADED,
                DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG, STATFLAG_NONAME,
                STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
                STREAM_SEEK_END, STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
            },
            DataExchange::{GetClipboardSequenceNumber, RegisterClipboardFormatW},
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{
                DoDragDrop, IDropSource, IDropSource_Impl, OleFlushClipboard, OleGetClipboard,
                OleInitialize, OleSetClipboard, ReleaseStgMedium, CF_HDROP, DROPEFFECT,
                DROPEFFECT_COPY, DROPEFFECT_MOVE,
            },
            SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            Threading::GetCurrentThreadId,
        },
        UI::{
            Shell::{
                DragQueryFileW, IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl,
                SHCreateStdEnumFmtEtc, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW,
                CFSTR_PASTESUCCEEDED, CFSTR_PERFORMEDDROPEFFECT, CFSTR_PREFERREDDROPEFFECT,
                DROPFILES, FD_ATTRIBUTES, FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME,
                HDROP,
            },
            WindowsAndMessaging::{
                DispatchMessageW, GetAncestor, GetCursorPos, GetMessageW, PeekMessageW,
                PostQuitMessage, PostThreadMessageW, TranslateMessage, WindowFromPoint, GA_ROOT,
                MSG, PM_NOREMOVE, WM_APP, WM_USER,
            },
        },
    },
};

const DRAGDROP_S_DROP: HRESULT = HRESULT(0x0004_0100);
const DRAGDROP_S_CANCEL: HRESULT = HRESULT(0x0004_0101);
const DRAGDROP_S_USEDEFAULTCURSORS: HRESULT = HRESULT(0x0004_0102);
/// FILEDESCRIPTORW.cFileName holds MAX_PATH UTF-16 units including NUL.
const MAX_DESCRIPTOR_NAME: usize = 259;
const PAYLOAD_FORMAT: &str = "Vesperwind File References";

fn native(error: windows::core::Error, message: &str) -> NativeError {
    NativeError::new("ESHELL", message).with_native_error(error.to_string())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn register_format(name: &str) -> u16 {
    let name = wide(name);
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
    unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) as u16 }
}

fn register_constant(name: PCWSTR) -> u16 {
    // SAFETY: shell format names are static NUL-terminated constants.
    unsafe { RegisterClipboardFormatW(name) as u16 }
}

struct Formats {
    payload: u16,
    descriptor: u16,
    contents: u16,
    preferred: u16,
    performed: u16,
    succeeded: u16,
}

fn formats() -> &'static Formats {
    static FORMATS: OnceLock<Formats> = OnceLock::new();
    FORMATS.get_or_init(|| Formats {
        payload: register_format(PAYLOAD_FORMAT),
        descriptor: register_constant(CFSTR_FILEDESCRIPTORW),
        contents: register_constant(CFSTR_FILECONTENTS),
        preferred: register_constant(CFSTR_PREFERREDDROPEFFECT),
        performed: register_constant(CFSTR_PERFORMEDDROPEFFECT),
        succeeded: register_constant(CFSTR_PASTESUCCEEDED),
    })
}

// ---------------------------------------------------------------------------
// HGLOBAL helpers

fn hglobal_from(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
    // SAFETY: a movable block of `len` bytes is allocated, locked, filled with
    // exactly `len` bytes and unlocked. Ownership passes to the STGMEDIUM.
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let target = GlobalLock(handle) as *mut u8;
        if target.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(E_OUTOFMEMORY.into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(handle)
    }
}

fn bytes_from_hglobal(handle: HGLOBAL) -> Vec<u8> {
    // SAFETY: the handle comes from a TYMED_HGLOBAL medium; GlobalSize bounds
    // the copy and the block is unlocked again before returning.
    unsafe {
        let size = GlobalSize(handle);
        let source = GlobalLock(handle) as *const u8;
        if source.is_null() {
            return vec![];
        }
        let bytes = std::slice::from_raw_parts(source, size).to_vec();
        let _ = GlobalUnlock(handle);
        bytes
    }
}

fn hglobal_medium(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
    Ok(STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 {
            hGlobal: hglobal_from(bytes)?,
        },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    })
}

fn format(cf: u16, tymed: u32, lindex: i32) -> FORMATETC {
    FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex,
        tymed,
    }
}

/// `DROPFILES` header followed by NUL-separated UTF-16 paths and a final NUL.
pub fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    let header = std::mem::size_of::<DROPFILES>();
    let mut bytes = vec![0u8; header];
    bytes[..4].copy_from_slice(&(header as u32).to_le_bytes());
    // fWide (BOOL) is the last field of DROPFILES.
    bytes[header - 4..header].copy_from_slice(&1u32.to_le_bytes());
    for path in paths {
        for unit in path.to_string_lossy().encode_utf16().chain(Some(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

fn unix_to_filetime(seconds: i64) -> FILETIME {
    let ticks = (seconds.max(0) as u64 + 11_644_473_600) * 10_000_000;
    FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    }
}

/// Serialize FILEGROUPDESCRIPTORW field by field (packed layout).
pub fn descriptor_bytes(entries: &[TreeEntry]) -> Result<Vec<u8>, NativeError> {
    let mut bytes = Vec::with_capacity(4 + entries.len() * 592);
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        let name: Vec<u16> = entry.relative.join("\\").encode_utf16().collect();
        if name.len() > MAX_DESCRIPTOR_NAME {
            return Err(NativeError::new(
                "ENAMETOOLONG",
                "A path inside the selection is too long for Windows Explorer",
            )
            .with_path(&entry.remote_path));
        }
        let flags = FD_ATTRIBUTES.0 as u32
            | FD_FILESIZE.0 as u32
            | FD_UNICODE.0 as u32
            | FD_PROGRESSUI.0 as u32
            | if entry.modified.is_some() {
                FD_WRITESTIME.0 as u32
            } else {
                0
            };
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 16]); // clsid
        bytes.extend_from_slice(&[0u8; 8]); // sizel
        bytes.extend_from_slice(&[0u8; 8]); // pointl
        let attributes = if entry.is_directory {
            FILE_ATTRIBUTE_DIRECTORY.0
        } else {
            FILE_ATTRIBUTE_NORMAL.0
        };
        bytes.extend_from_slice(&attributes.to_le_bytes());
        let written = entry.modified.map(unix_to_filetime).unwrap_or_default();
        for time in [FILETIME::default(), FILETIME::default(), written] {
            bytes.extend_from_slice(&time.dwLowDateTime.to_le_bytes());
            bytes.extend_from_slice(&time.dwHighDateTime.to_le_bytes());
        }
        bytes.extend_from_slice(&((entry.size >> 32) as u32).to_le_bytes());
        bytes.extend_from_slice(&(entry.size as u32).to_le_bytes());
        let mut field = [0u16; 260];
        field[..name.len()].copy_from_slice(&name);
        for unit in field {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Streams (created in the MTA, see module docs)

struct StreamState {
    reader: Option<Box<dyn Read + Send>>,
    position: u64,
}

#[implement(IStream, Agile = false)]
struct ProviderStream {
    files: ProviderFiles,
    provider: String,
    path: String,
    name: String,
    size: u64,
    state: Mutex<StreamState>,
    cancelled: Arc<AtomicBool>,
}

impl ProviderStream {
    fn reader<'a>(
        &self,
        state: &'a mut StreamState,
    ) -> windows::core::Result<&'a mut Box<dyn Read + Send>> {
        if state.reader.is_none() {
            let mut reader = self
                .files
                .open(&self.provider, &self.path)
                .map_err(|error| {
                    emit("native-drag:error", serde_json::json!({ "error": error }));
                    windows::core::Error::from(STG_E_READFAULT)
                })?;
            // Re-open after a backwards seek: skip forward in bounded chunks.
            let mut skip = state.position;
            let mut buffer = vec![0u8; 64 * 1024];
            while skip > 0 {
                let chunk = skip.min(buffer.len() as u64) as usize;
                let read = reader
                    .read(&mut buffer[..chunk])
                    .map_err(|_| STG_E_READFAULT)?;
                if read == 0 {
                    break;
                }
                skip -= read as u64;
            }
            state.reader = Some(reader);
        }
        Ok(state.reader.as_mut().unwrap())
    }
}

impl ISequentialStream_Impl for ProviderStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return E_INVALIDARG;
        }
        if self.cancelled.load(Ordering::Acquire) {
            return STG_E_READFAULT;
        }
        let mut state = self.state.lock().unwrap_or_else(|v| v.into_inner());
        // SAFETY: COM guarantees `pv` points to `cb` writable bytes.
        let buffer = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let mut filled = 0usize;
        while filled < buffer.len() {
            let reader = match self.reader(&mut state) {
                Ok(reader) => reader,
                Err(error) => return error.code(),
            };
            match reader.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return STG_E_READFAULT,
            }
        }
        state.position += filled as u64;
        if !pcbread.is_null() {
            // SAFETY: optional out pointer supplied by the caller.
            unsafe { *pcbread = filled as u32 };
        }
        if filled < buffer.len() {
            S_FALSE
        } else {
            S_OK
        }
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for ProviderStream_Impl {
    fn Seek(
        &self,
        dlibmove: i64,
        dworigin: STREAM_SEEK,
        plibnewposition: *mut u64,
    ) -> windows::core::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|v| v.into_inner());
        let base = match dworigin {
            STREAM_SEEK_SET => 0i128,
            STREAM_SEEK_CUR => state.position as i128,
            STREAM_SEEK_END => self.size as i128,
            _ => return Err(STG_E_INVALIDFUNCTION.into()),
        };
        let target = base + dlibmove as i128;
        if target < 0 {
            return Err(STG_E_INVALIDFUNCTION.into());
        }
        let target = target as u64;
        if target != state.position {
            if target > state.position
                && state.reader.is_some()
                && target - state.position <= 16 * 1024 * 1024
            {
                // Short forward seek: discard bytes from the open stream.
                let mut remaining = target - state.position;
                let mut buffer = vec![0u8; 64 * 1024];
                let reader = state.reader.as_mut().unwrap();
                while remaining > 0 {
                    let chunk = remaining.min(buffer.len() as u64) as usize;
                    let read = reader
                        .read(&mut buffer[..chunk])
                        .map_err(|_| STG_E_READFAULT)?;
                    if read == 0 {
                        break;
                    }
                    remaining -= read as u64;
                }
            } else {
                state.reader = None;
            }
            state.position = target;
        }
        if !plibnewposition.is_null() {
            // SAFETY: optional out pointer supplied by the caller.
            unsafe { *plibnewposition = state.position };
        }
        Ok(())
    }

    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(
        &self,
        pstm: windows::core::Ref<'_, IStream>,
        cb: u64,
        pcbread: *mut u64,
        pcbwritten: *mut u64,
    ) -> windows::core::Result<()> {
        let target = pstm.ok()?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut total_read = 0u64;
        let mut total_written = 0u64;
        while total_read < cb {
            let want = (cb - total_read).min(buffer.len() as u64) as u32;
            let mut read = 0u32;
            let status =
                ISequentialStream_Impl::Read(self, buffer.as_mut_ptr().cast(), want, &mut read);
            status.ok()?;
            if read == 0 {
                break;
            }
            total_read += read as u64;
            let mut written = 0u32;
            // SAFETY: `buffer` holds `read` initialized bytes.
            unsafe { target.Write(buffer.as_ptr().cast(), read, Some(&mut written)) }.ok()?;
            total_written += written as u64;
            if status == S_FALSE {
                break;
            }
        }
        // SAFETY: optional out pointers supplied by the caller.
        unsafe {
            if !pcbread.is_null() {
                *pcbread = total_read;
            }
            if !pcbwritten.is_null() {
                *pcbwritten = total_written;
            }
        }
        Ok(())
    }

    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Ok(())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Stat(&self, pstatstg: *mut STATSTG, grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        if pstatstg.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let mut stat = STATSTG {
            r#type: STGTY_STREAM.0 as u32,
            cbSize: self.size,
            ..Default::default()
        };
        if *grfstatflag != STATFLAG_NONAME {
            let name = wide(&self.name);
            // SAFETY: CoTaskMemAlloc'd name buffer; the caller frees it.
            unsafe {
                let buffer = CoTaskMemAlloc(name.len() * 2) as *mut u16;
                if !buffer.is_null() {
                    std::ptr::copy_nonoverlapping(name.as_ptr(), buffer, name.len());
                    stat.pwcsName = PWSTR(buffer);
                }
            }
        }
        // SAFETY: `pstatstg` is a caller-provided STATSTG.
        unsafe { pstatstg.write(stat) };
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// Keeps a multithreaded apartment alive for stream objects.
fn mta() -> &'static mpsc::SyncSender<Box<dyn FnOnce() + Send>> {
    static MTA: OnceLock<mpsc::SyncSender<Box<dyn FnOnce() + Send>>> = OnceLock::new();
    MTA.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(16);
        std::thread::Builder::new()
            .name("vesperwind-shell-mta".into())
            .spawn(move || {
                // SAFETY: initializes COM for this dedicated thread only.
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                for job in receiver {
                    job();
                }
            })
            .expect("unable to start the shell MTA thread");
        sender
    })
}

struct SendStream(IStream);
// SAFETY: the ProviderStream object is thread-safe (Mutex state, Send+Sync
// fields) and is only handed to the MTA for marshaling.
unsafe impl Send for SendStream {}
struct SendUnknownStream(windows::Win32::System::Com::IStream);
// SAFETY: a marshaling stream (CoMarshalInterThreadInterfaceInStream) is
// explicitly designed to cross apartments.
unsafe impl Send for SendUnknownStream {}

/// Create the stream's COM identity in the MTA and return a proxy usable in
/// the caller's apartment.
fn mta_stream(stream: ProviderStream) -> windows::core::Result<IStream> {
    let object: IStream = stream.into();
    let (sender, receiver) = mpsc::channel();
    let carrier = SendStream(object);
    mta()
        .send(Box::new(move || {
            let carrier = carrier;
            // SAFETY: marshals the interface for another apartment; the
            // returned stream is consumed by CoGetInterfaceAndReleaseStream.
            let result =
                unsafe { CoMarshalInterThreadInterfaceInStream(&IStream::IID, &carrier.0) }
                    .map(SendUnknownStream);
            let _ = sender.send(result);
        }))
        .map_err(|_| windows::core::Error::from(E_FAIL))?;
    let marshaled = receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| windows::core::Error::from(E_FAIL))??;
    // SAFETY: `marshaled` came from CoMarshalInterThreadInterfaceInStream.
    unsafe { CoGetInterfaceAndReleaseStream::<_, IStream>(&marshaled.0) }
}

// ---------------------------------------------------------------------------
// The data object

enum Content {
    /// Real local paths only.
    Local(Vec<PathBuf>),
    /// Any remote item: everything is published as virtual files.
    Virtual {
        items: Vec<ClipboardFileRef>,
        files: ProviderFiles,
        entries: OnceLock<Result<Vec<(String, TreeEntry)>, NativeError>>,
    },
}

type PasteCallback = Arc<dyn Fn(u32) + Send + Sync>;

#[implement(IDataObject, IDataObjectAsyncCapability)]
struct ShellDataObject {
    payload: Vec<u8>,
    content: Content,
    preferred: u32,
    stored: Mutex<Vec<(u16, Vec<u8>)>>,
    asynchronous: AtomicBool,
    in_operation: AtomicBool,
    on_paste: Option<PasteCallback>,
    cancelled: Arc<AtomicBool>,
}

impl ShellDataObject {
    fn new(
        payload: &ClipboardPayload,
        files: ProviderFiles,
        on_paste: Option<PasteCallback>,
    ) -> Self {
        let local = payload.items.iter().all(ClipboardFileRef::is_local);
        let content = if local {
            Content::Local(
                payload
                    .items
                    .iter()
                    .map(|item| PathBuf::from(&item.path))
                    .collect(),
            )
        } else {
            Content::Virtual {
                items: payload.items.clone(),
                files,
                entries: OnceLock::new(),
            }
        };
        // Explorer performs moves of real files itself. Remote originals are
        // never deleted on Explorer's behalf, so remote items are copies.
        let preferred = if payload.operation == ClipboardOperation::Cut && local {
            DROPEFFECT_MOVE.0
        } else {
            DROPEFFECT_COPY.0
        };
        Self {
            payload: payload.encode(),
            asynchronous: AtomicBool::new(!local),
            content,
            preferred,
            stored: Mutex::new(vec![]),
            in_operation: AtomicBool::new(false),
            on_paste,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    fn entries(&self) -> Result<&[(String, TreeEntry)], NativeError> {
        let Content::Virtual {
            items,
            files,
            entries,
        } = &self.content
        else {
            return Ok(&[]);
        };
        entries
            .get_or_init(|| {
                let mut all = vec![];
                for item in items {
                    all.extend(
                        transfer::walk(files, &item.provider_id, &item.path, &self.cancelled)?
                            .into_iter()
                            .map(|entry| (item.provider_id.clone(), entry)),
                    );
                    if all.len() > transfer::MAX_TREE_ENTRIES {
                        return Err(NativeError::new(
                            "ETOO_MANY_ITEMS",
                            "The selection contains too many files for Explorer",
                        ));
                    }
                }
                Ok(all)
            })
            .as_deref()
            .map_err(Clone::clone)
    }

    fn available(&self) -> Vec<FORMATETC> {
        let formats = formats();
        let mut list = vec![
            format(formats.payload, TYMED_HGLOBAL.0 as u32, -1),
            format(formats.preferred, TYMED_HGLOBAL.0 as u32, -1),
        ];
        match self.content {
            Content::Local(_) => list.insert(0, format(CF_HDROP.0, TYMED_HGLOBAL.0 as u32, -1)),
            Content::Virtual { .. } => {
                list.insert(0, format(formats.descriptor, TYMED_HGLOBAL.0 as u32, -1));
                list.insert(1, format(formats.contents, TYMED_ISTREAM.0 as u32, -1));
            }
        }
        for (cf, _) in self.stored.lock().unwrap_or_else(|v| v.into_inner()).iter() {
            if !list.iter().any(|entry| entry.cfFormat == *cf) {
                list.push(format(*cf, TYMED_HGLOBAL.0 as u32, -1));
            }
        }
        list
    }
}

impl IDataObject_Impl for ShellDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        // SAFETY: COM passes a valid FORMATETC pointer (checked for null).
        let request =
            unsafe { pformatetcin.as_ref() }.ok_or(windows::core::Error::from(E_INVALIDARG))?;
        let formats = formats();
        let wants = |tymed: u32| request.tymed & tymed != 0;
        if request.cfFormat == formats.contents {
            if !wants(TYMED_ISTREAM.0 as u32) {
                return Err(DV_E_TYMED.into());
            }
            let Content::Virtual { files, .. } = &self.content else {
                return Err(DV_E_FORMATETC.into());
            };
            let entries = self.entries().map_err(|error| {
                emit("native-drag:error", serde_json::json!({ "error": error }));
                windows::core::Error::from(E_FAIL)
            })?;
            let (provider, entry) = usize::try_from(request.lindex)
                .ok()
                .and_then(|index| entries.get(index))
                .filter(|(_, entry)| !entry.is_directory)
                .ok_or(windows::core::Error::from(DV_E_LINDEX))?;
            let provider = provider.clone();
            let stream = mta_stream(ProviderStream {
                files: files.clone(),
                provider,
                path: entry.remote_path.clone(),
                name: entry.relative.last().cloned().unwrap_or_default(),
                size: entry.size,
                state: Mutex::new(StreamState {
                    reader: None,
                    position: 0,
                }),
                cancelled: Arc::clone(&self.cancelled),
            })?;
            return Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 {
                    pstm: std::mem::ManuallyDrop::new(Some(stream)),
                },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            });
        }
        if !wants(TYMED_HGLOBAL.0 as u32) {
            return Err(DV_E_TYMED.into());
        }
        let bytes = if request.cfFormat == CF_HDROP.0 {
            match &self.content {
                Content::Local(paths) => hdrop_bytes(paths),
                Content::Virtual { .. } => return Err(DV_E_FORMATETC.into()),
            }
        } else if request.cfFormat == formats.descriptor {
            let entries = self.entries().map_err(|error| {
                emit("native-drag:error", serde_json::json!({ "error": error }));
                windows::core::Error::from(E_FAIL)
            })?;
            let entries: Vec<TreeEntry> = entries.iter().map(|(_, entry)| entry.clone()).collect();
            descriptor_bytes(&entries).map_err(|error| {
                emit("native-drag:error", serde_json::json!({ "error": error }));
                windows::core::Error::from(E_FAIL)
            })?
        } else if request.cfFormat == formats.preferred {
            self.preferred.to_le_bytes().to_vec()
        } else if request.cfFormat == formats.payload {
            self.payload.clone()
        } else if let Some((_, bytes)) = self
            .stored
            .lock()
            .unwrap_or_else(|v| v.into_inner())
            .iter()
            .find(|(cf, _)| *cf == request.cfFormat)
        {
            bytes.clone()
        } else {
            return Err(DV_E_FORMATETC.into());
        };
        hglobal_medium(&bytes)
    }

    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        // SAFETY: COM passes a valid FORMATETC pointer (checked for null).
        let Some(request) = (unsafe { pformatetc.as_ref() }) else {
            return E_INVALIDARG;
        };
        match self
            .available()
            .iter()
            .find(|entry| entry.cfFormat == request.cfFormat)
        {
            Some(entry) if entry.tymed & request.tymed != 0 => S_OK,
            Some(_) => DV_E_TYMED,
            None => DV_E_FORMATETC,
        }
    }

    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, pformatetcout: *mut FORMATETC) -> HRESULT {
        if !pformatetcout.is_null() {
            // SAFETY: caller-provided out structure.
            unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        pformatetc: *const FORMATETC,
        pmedium: *const STGMEDIUM,
        frelease: BOOL,
    ) -> windows::core::Result<()> {
        // SAFETY: COM passes valid pointers; checked for null.
        let (request, medium) = unsafe { (pformatetc.as_ref(), pmedium.as_ref()) };
        let (Some(request), Some(medium)) = (request, medium) else {
            return Err(E_INVALIDARG.into());
        };
        if medium.tymed != TYMED_HGLOBAL.0 as u32 {
            return Err(DV_E_TYMED.into());
        }
        // SAFETY: tymed says the union holds an HGLOBAL.
        let bytes = bytes_from_hglobal(unsafe { medium.u.hGlobal });
        if frelease.as_bool() {
            // SAFETY: with fRelease the callee owns the medium.
            unsafe { ReleaseStgMedium(pmedium as *mut STGMEDIUM) };
        }
        let formats = formats();
        if request.cfFormat == formats.succeeded || request.cfFormat == formats.performed {
            let effect = bytes
                .get(..4)
                .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
                .unwrap_or(0);
            if request.cfFormat == formats.succeeded {
                if let Some(callback) = &self.on_paste {
                    callback(effect);
                }
            }
        }
        let mut stored = self.stored.lock().unwrap_or_else(|v| v.into_inner());
        stored.retain(|(cf, _)| *cf != request.cfFormat);
        // Shell helpers store small formats (drag image, drop description).
        if stored.len() < 64 && bytes.len() <= 16 * 1024 * 1024 {
            stored.push((request.cfFormat, bytes));
        }
        Ok(())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        // SAFETY: the slice outlives the call; the shell copies it.
        unsafe { SHCreateStdEnumFmtEtc(&self.available()) }
    }

    fn DAdvise(
        &self,
        _: *const FORMATETC,
        _: u32,
        _: windows::core::Ref<'_, IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

impl IDataObjectAsyncCapability_Impl for ShellDataObject_Impl {
    fn SetAsyncMode(&self, fdoopasync: BOOL) -> windows::core::Result<()> {
        self.asynchronous
            .store(fdoopasync.as_bool(), Ordering::Release);
        Ok(())
    }

    fn GetAsyncMode(&self) -> windows::core::Result<BOOL> {
        Ok(self.asynchronous.load(Ordering::Acquire).into())
    }

    fn StartOperation(&self, _: windows::core::Ref<'_, IBindCtx>) -> windows::core::Result<()> {
        self.in_operation.store(true, Ordering::Release);
        Ok(())
    }

    fn InOperation(&self) -> windows::core::Result<BOOL> {
        Ok(self.in_operation.load(Ordering::Acquire).into())
    }

    fn EndOperation(
        &self,
        _: HRESULT,
        _: windows::core::Ref<'_, IBindCtx>,
        _: u32,
    ) -> windows::core::Result<()> {
        self.in_operation.store(false, Ordering::Release);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Clipboard STA thread

type Job = Box<dyn FnOnce() + Send>;

struct ShellThread {
    id: u32,
    queue: Arc<Mutex<VecDeque<Job>>>,
}

thread_local! {
    /// Clipboard object owned by the shell thread: (token, object, remote).
    /// The sequence number identifies ownership: it changes whenever any
    /// process writes the clipboard (OleIsCurrentClipboard's S_FALSE is not
    /// observable through windows-rs `Result`).
    static CURRENT: RefCell<Option<(String, IDataObject, bool, u32)>> = const { RefCell::new(None) };
}

fn shell_thread() -> Result<&'static ShellThread, NativeError> {
    static THREAD: OnceLock<Option<ShellThread>> = OnceLock::new();
    THREAD
        .get_or_init(|| {
            let queue: Arc<Mutex<VecDeque<Job>>> = Arc::default();
            let jobs = Arc::clone(&queue);
            let (ready, started) = mpsc::channel();
            std::thread::Builder::new()
                .name("vesperwind-shell-sta".into())
                .spawn(move || {
                    // SAFETY: OLE (STA) for this thread; it pumps messages for
                    // its whole lifetime, as OleSetClipboard requires.
                    let initialized = unsafe { OleInitialize(None) }.is_ok();
                    let mut message = MSG::default();
                    // SAFETY: creates this thread's message queue before its id
                    // is published, so PostThreadMessageW cannot be lost.
                    unsafe {
                        let _ = PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE);
                    }
                    let _ = ready.send(initialized.then(|| unsafe { GetCurrentThreadId() }));
                    loop {
                        // SAFETY: standard message loop on this thread.
                        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                        if result.0 <= 0 {
                            break;
                        }
                        if message.hwnd.0.is_null() && message.message == WM_APP {
                            while let Some(job) =
                                jobs.lock().unwrap_or_else(|v| v.into_inner()).pop_front()
                            {
                                job();
                            }
                            continue;
                        }
                        unsafe {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                })
                .ok()?;
            let id = started
                .recv_timeout(Duration::from_secs(5))
                .ok()
                .flatten()?;
            Some(ShellThread { id, queue })
        })
        .as_ref()
        .ok_or_else(|| NativeError::new("ESHELL", "Windows OLE could not be initialized"))
}

fn on_shell<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, NativeError> {
    let thread = shell_thread()?;
    let (sender, receiver) = mpsc::channel();
    thread
        .queue
        .lock()
        .unwrap_or_else(|v| v.into_inner())
        .push_back(Box::new(move || {
            let _ = sender.send(work());
        }));
    // SAFETY: posts a thread message to the shell thread's queue.
    unsafe { PostThreadMessageW(thread.id, WM_APP, WPARAM(0), LPARAM(0)) }
        .map_err(|error| native(error, "The Windows shell thread is unavailable"))?;
    receiver
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| NativeError::new("ESHELL", "The Windows shell thread did not respond"))
}

fn paste_callback(token: String) -> PasteCallback {
    Arc::new(move |effect| {
        // Explorer finished pasting our Cut (it moved the real files itself).
        if effect & DROPEFFECT_MOVE.0 != 0 {
            emit("clipboard:consumed", serde_json::json!({ "token": token }));
        }
    })
}

pub fn write_clipboard(payload: ClipboardPayload, files: ProviderFiles) -> Result<(), NativeError> {
    on_shell(move || {
        let remote = !payload.items.iter().all(ClipboardFileRef::is_local);
        let object: IDataObject =
            ShellDataObject::new(&payload, files, Some(paste_callback(payload.token.clone())))
                .into();
        // SAFETY: called on the OLE-initialized shell thread.
        unsafe { OleSetClipboard(&object) }
            .map_err(|error| native(error, "Windows rejected the clipboard contents"))?;
        // SAFETY: plain clipboard query.
        let sequence = unsafe { GetClipboardSequenceNumber() };
        CURRENT.with(|current| {
            *current.borrow_mut() = Some((payload.token, object, remote, sequence))
        });
        Ok(())
    })?
}

fn medium_bytes(object: &IDataObject, cf: u16) -> Option<Vec<u8>> {
    let request = format(cf, TYMED_HGLOBAL.0 as u32, -1);
    // SAFETY: GetData returns an owned medium released below.
    let mut medium = unsafe { object.GetData(&request) }.ok()?;
    let bytes = (medium.tymed == TYMED_HGLOBAL.0 as u32)
        // SAFETY: tymed says the union holds an HGLOBAL.
        .then(|| bytes_from_hglobal(unsafe { medium.u.hGlobal }));
    // SAFETY: releases the medium returned by GetData.
    unsafe { ReleaseStgMedium(&mut medium) };
    bytes
}

fn hdrop_paths(object: &IDataObject) -> Vec<PathBuf> {
    let request = format(CF_HDROP.0, TYMED_HGLOBAL.0 as u32, -1);
    // SAFETY: GetData returns an owned medium released below.
    let Ok(mut medium) = (unsafe { object.GetData(&request) }) else {
        return vec![];
    };
    let mut paths = vec![];
    if medium.tymed == TYMED_HGLOBAL.0 as u32 {
        // SAFETY: a CF_HDROP HGLOBAL is an HDROP; buffers are sized by the
        // length query (`None`) before each copy.
        unsafe {
            let drop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            for index in 0..count.min(super::clipboard::MAX_CLIPBOARD_ITEMS as u32) {
                let length = DragQueryFileW(drop, index, None) as usize;
                let mut buffer = vec![0u16; length + 1];
                let copied = DragQueryFileW(drop, index, Some(&mut buffer)) as usize;
                paths.push(PathBuf::from(String::from_utf16_lossy(&buffer[..copied])));
            }
        }
    }
    // SAFETY: releases the medium returned by GetData.
    unsafe { ReleaseStgMedium(&mut medium) };
    paths
}

fn local_ref(path: &Path) -> Option<ClipboardFileRef> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(ClipboardFileRef {
        provider_id: "local".into(),
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        is_directory: metadata.is_dir(),
    })
}

pub fn read_clipboard() -> Result<SystemClipboard, NativeError> {
    on_shell(|| {
        // SAFETY: called on the OLE-initialized shell thread.
        let Ok(object) = (unsafe { OleGetClipboard() }) else {
            return SystemClipboard::default();
        };
        let formats = formats();
        let payload = medium_bytes(&object, formats.payload)
            .and_then(|bytes| ClipboardPayload::decode(&bytes));
        let preferred = medium_bytes(&object, formats.preferred)
            .and_then(|bytes| {
                bytes
                    .get(..4)
                    .map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
            })
            .map(|effect| {
                if effect & DROPEFFECT_MOVE.0 != 0 {
                    ClipboardOperation::Cut
                } else {
                    ClipboardOperation::Copy
                }
            });
        SystemClipboard {
            payload,
            local_files: hdrop_paths(&object)
                .iter()
                .filter_map(|path| local_ref(path))
                .collect(),
            preferred,
        }
    })
}

/// After Vesperwind pasted: clear our own Cut, or tell Explorer that we
/// performed the move of its Cut (optimized move) and empty the clipboard.
pub fn finish_paste(token: Option<String>) -> Result<(), NativeError> {
    on_shell(move || {
        let formats = formats();
        match token {
            Some(token) => {
                let owned = CURRENT.with(|current| {
                    current
                        .borrow()
                        .as_ref()
                        .filter(|(current, ..)| *current == token)
                        // SAFETY: plain clipboard query.
                        .is_some_and(
                            |(.., sequence)| unsafe { GetClipboardSequenceNumber() } == *sequence,
                        )
                });
                if owned {
                    // SAFETY: called on the OLE-initialized shell thread.
                    let _ = unsafe { OleSetClipboard(None) };
                    CURRENT.with(|current| current.borrow_mut().take());
                }
            }
            None => {
                // SAFETY: called on the OLE-initialized shell thread.
                if let Ok(object) = unsafe { OleGetClipboard() } {
                    let effect = DROPEFFECT_MOVE.0.to_le_bytes();
                    for cf in [formats.performed, formats.succeeded] {
                        if let Ok(medium) = hglobal_medium(&effect) {
                            let request = format(cf, TYMED_HGLOBAL.0 as u32, -1);
                            // SAFETY: fRelease = TRUE hands the medium to the source.
                            if unsafe { object.SetData(&request, &medium, true) }.is_err() {
                                // SAFETY: the source did not take ownership.
                                unsafe {
                                    let _ = GlobalFree(Some(medium.u.hGlobal));
                                }
                            }
                        }
                    }
                    // SAFETY: called on the OLE-initialized shell thread.
                    let _ = unsafe { OleSetClipboard(None) };
                }
            }
        }
    })
}

pub fn shutdown() {
    let _ = on_shell(|| {
        CURRENT.with(|current| {
            if let Some((_, _object, remote, sequence)) = current.borrow_mut().take() {
                // SAFETY: OLE calls on the shell thread that owns the object.
                unsafe {
                    if GetClipboardSequenceNumber() == sequence {
                        if remote {
                            // Virtual files need this process; do not leave a
                            // clipboard that can no longer deliver content.
                            let _ = OleSetClipboard(None);
                        } else {
                            // Render CF_HDROP & co. so the copy survives us.
                            let _ = OleFlushClipboard();
                        }
                    }
                }
            }
        });
        // SAFETY: ends the shell thread's message loop.
        unsafe { PostQuitMessage(0) };
    });
}

// ---------------------------------------------------------------------------
// Drag and drop

#[implement(IDropSource)]
struct DropSource {
    /// Top-level window handle value (HWND is not Send).
    window: isize,
    internal: Arc<Mutex<Option<(i32, i32)>>>,
}

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if grfkeystate.0 & MK_LBUTTON.0 != 0 {
            return S_OK;
        }
        let mut point = POINT::default();
        // SAFETY: plain Win32 queries with valid out pointers.
        let inside = unsafe {
            GetCursorPos(&mut point).is_ok()
                && GetAncestor(WindowFromPoint(point), GA_ROOT).0 as isize == self.window
        };
        if inside {
            // Never let WebView2 receive our own virtual files (Chromium would
            // materialize them); resolve the drop inside Vesperwind instead.
            *self.internal.lock().unwrap_or_else(|v| v.into_inner()) = Some((point.x, point.y));
            DRAGDROP_S_CANCEL
        } else {
            DRAGDROP_S_DROP
        }
    }

    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

pub fn start_drag(
    app: &AppHandle,
    items: Vec<DragItem>,
    files: ProviderFiles,
) -> Result<(), NativeError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| NativeError::new("ENATIVE", "The main window is unavailable"))?;
    let hwnd = window.hwnd().map_err(|error| {
        NativeError::new("ENATIVE", "The main window is unavailable")
            .with_native_error(error.to_string())
    })?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let payload = ClipboardPayload {
        version: super::clipboard::PAYLOAD_VERSION,
        instance: String::new(),
        token: uuid::Uuid::new_v4().to_string(),
        operation: ClipboardOperation::Copy,
        items,
    };
    let hwnd_value = hwnd.0 as isize;
    app.run_on_main_thread(move || {
        let hwnd = HWND(hwnd_value as *mut core::ffi::c_void);
        // SAFETY: the main (UI) thread is an STA; OleInitialize is
        // reference-counted and returns S_FALSE when already initialized.
        let _ = unsafe { OleInitialize(None) };
        let object: IDataObject = ShellDataObject::new(&payload, files, None).into();
        let internal = Arc::new(Mutex::new(None));
        let source: IDropSource = DropSource {
            window: hwnd_value,
            internal: Arc::clone(&internal),
        }
        .into();
        let mut effect = DROPEFFECT(0);
        // SAFETY: DoDragDrop runs a modal loop on this STA thread with live
        // COM objects; the mouse button is still held when this is invoked.
        let result = unsafe { DoDragDrop(&object, &source, DROPEFFECT_COPY, &mut effect) };
        let internal = *internal.lock().unwrap_or_else(|v| v.into_inner());
        if let Some((x, y)) = internal {
            let mut point = POINT { x, y };
            // SAFETY: converts a screen point for our own window.
            if unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
                emit(
                    "native-drag:drop",
                    serde_json::json!({ "x": point.x as f64 / scale, "y": point.y as f64 / scale }),
                );
            }
        }
        emit(
            "native-drag:end",
            serde_json::json!({ "operation": effect.0, "result": result.0 }),
        );
    })
    .map_err(|error| {
        NativeError::new("ENATIVE", "Unable to start the drag").with_native_error(error.to_string())
    })
}

// ---------------------------------------------------------------------------
// Explorer drops onto the WebView

#[derive(Default)]
struct PendingDrops {
    drops: Mutex<HashMap<String, (Instant, Vec<PathBuf>)>>,
    arrived: Condvar,
}

fn pending() -> &'static PendingDrops {
    static PENDING: OnceLock<PendingDrops> = OnceLock::new();
    PENDING.get_or_init(PendingDrops::default)
}

pub fn setup(app: &AppHandle) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        },
        WebMessageReceivedEventHandler,
    };
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let _ = webview.with_webview(|platform| {
        // SAFETY: WebView2 calls on the UI thread that owns the controller.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|core| {
                let mut token = 0i64;
                core.add_WebMessageReceived(
                    &WebMessageReceivedEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut json = PWSTR::null();
                        args.WebMessageAsJson(&mut json)?;
                        let message: serde_json::Value =
                            serde_json::from_str(&webview2_com::take_pwstr(json))
                                .unwrap_or_default();
                        let Some(id) = message
                            .get("vesperwindFileDrop")
                            .and_then(|value| value.as_str())
                            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                        else {
                            return Ok(());
                        };
                        let args: ICoreWebView2WebMessageReceivedEventArgs2 = args.cast()?;
                        let objects = args.AdditionalObjects()?;
                        let mut count = 0u32;
                        objects.Count(&mut count)?;
                        let mut paths = vec![];
                        for index in 0..count.min(super::clipboard::MAX_CLIPBOARD_ITEMS as u32) {
                            let Ok(file) = objects
                                .GetValueAtIndex(index)
                                .and_then(|o| o.cast::<ICoreWebView2File>())
                            else {
                                continue;
                            };
                            let mut path = PWSTR::null();
                            if file.Path(&mut path).is_ok() {
                                paths.push(PathBuf::from(webview2_com::take_pwstr(path)));
                            }
                        }
                        let pending = pending();
                        let mut drops = pending.drops.lock().unwrap_or_else(|v| v.into_inner());
                        drops.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(30));
                        drops.insert(id.to_string(), (Instant::now(), paths));
                        pending.arrived.notify_all();
                        Ok(())
                    })),
                    &mut token,
                )
            })
        };
        if let Err(error) = result {
            eprintln!("Vesperwind: unable to receive Explorer drops: {error}");
        }
    });
}

/// Paths WebView2 reported for the page's File objects of drop `id`.
pub fn take_drop(id: &str) -> Result<Vec<ClipboardFileRef>, NativeError> {
    let pending = pending();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut drops = pending.drops.lock().unwrap_or_else(|v| v.into_inner());
    loop {
        if let Some((_, paths)) = drops.remove(id) {
            return Ok(paths.iter().filter_map(|path| local_ref(path)).collect());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(NativeError::new(
                "EDROP_UNAVAILABLE",
                "Windows did not report the dropped files",
            ));
        }
        drops = pending
            .arrived
            .wait_timeout(drops, deadline - now)
            .unwrap_or_else(|v| v.into_inner())
            .0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdrop_layout_is_wide_and_double_terminated() {
        let bytes = hdrop_bytes(&[PathBuf::from(r"C:\Тест\a b.txt"), PathBuf::from(r"D:\x")]);
        let header = std::mem::size_of::<DROPFILES>();
        assert_eq!(
            u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            header
        );
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }

    #[test]
    fn descriptors_reject_names_beyond_max_path() {
        let entry = |name: String| TreeEntry {
            relative: vec![name],
            remote_path: "/x".into(),
            is_directory: false,
            size: 5_000_000_000,
            modified: Some(0),
        };
        let bytes = descriptor_bytes(&[entry("ok.txt".into())]).unwrap();
        assert_eq!(bytes.len(), 4 + 592);
        assert_eq!(
            descriptor_bytes(&[entry("a".repeat(300))])
                .unwrap_err()
                .code,
            "ENAMETOOLONG"
        );
    }
}
