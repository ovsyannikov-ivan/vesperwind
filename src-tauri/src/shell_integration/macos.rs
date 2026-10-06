//! AppKit integration: NSPasteboard file clipboard, the drag pasteboard for
//! inbound Finder drops, and outbound drag sessions with file URLs (local)
//! and NSFilePromiseProvider (SFTP).
//!
//! Threading: every AppKit object here is created and used on the main
//! thread (`MainThreadMarker`), except the promise delegate, which AppKit
//! calls on the operation queue we return; that class is `AllocAnyThread`
//! and its ivars are `Send + Sync`.
use super::{
    clipboard::{ClipboardFileRef, ClipboardPayload, SystemClipboard},
    emit,
    transfer::{self, ProviderFiles},
    DragItem,
};
use crate::error::NativeError;
use block2::RcBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, ProtocolObject, Sel},
    sel, AllocAnyThread, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingFormation, NSDraggingInfo,
    NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent, NSEventType,
    NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSPasteboard, NSPasteboardItem,
    NSPasteboardNameDrag, NSPasteboardTypeFileURL, NSPasteboardTypeString,
    NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting, NSView, NSWorkspace,
};
use objc2_foundation::{
    ns_string, NSArray, NSCocoaErrorDomain, NSData, NSDictionary, NSError, NSNumber, NSObject,
    NSObjectProtocol, NSOperationQueue, NSPoint, NSProgress,
    NSProgressFileOperationKindDownloading, NSProgressKindFile, NSRect, NSSize, NSString, NSURL,
};
use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, OnceLock,
    },
};
use tauri::{AppHandle, Manager};

/// Custom UTI carrying the Vesperwind payload next to file URLs.
const PAYLOAD_TYPE: &str = "com.vesperwind.file-references";

/// Run `work` on the AppKit main thread and wait for its result.
pub fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
) -> Result<T, NativeError> {
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(work(mtm));
    }
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let mtm = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
        let _ = sender.send(work(mtm));
    })
    .map_err(|error| {
        NativeError::new("ENATIVE", "The main thread is unavailable")
            .with_native_error(error.to_string())
    })?;
    receiver
        .recv()
        .map_err(|_| NativeError::new("ENATIVE", "The main thread did not answer"))
}

fn file_refs(pasteboard: &NSPasteboard) -> Vec<ClipboardFileRef> {
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let options = NSDictionary::from_slices(
        // SAFETY: AppKit's documented option key with an NSNumber value.
        &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
        &[&*NSNumber::new_bool(true) as &AnyObject],
    );
    // SAFETY: the class array holds NSURL and the options are well-typed.
    let Some(objects) =
        (unsafe { pasteboard.readObjectsForClasses_options(&classes, Some(&options)) })
    else {
        return vec![];
    };
    objects
        .iter()
        .filter_map(|object| object.downcast::<NSURL>().ok())
        .filter_map(|url| url.path().map(|path| PathBuf::from(path.to_string())))
        .filter_map(|path| local_ref(&path))
        .collect()
}

pub(super) fn local_ref(path: &Path) -> Option<ClipboardFileRef> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(ClipboardFileRef {
        provider_id: "local".into(),
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        is_directory: metadata.is_dir(),
    })
}

fn read_pasteboard(pasteboard: &NSPasteboard) -> SystemClipboard {
    let payload = pasteboard
        .dataForType(&NSString::from_str(PAYLOAD_TYPE))
        .and_then(|data| ClipboardPayload::decode(&data.to_vec()));
    SystemClipboard {
        payload,
        local_files: file_refs(pasteboard),
        // Finder has no file Cut; copied files are always copies.
        preferred: None,
    }
}

pub fn read_clipboard(app: &AppHandle) -> Result<SystemClipboard, NativeError> {
    on_main(app, |_| read_pasteboard(&NSPasteboard::generalPasteboard()))
}

/// The payload currently on the general pasteboard (cheap ownership check).
pub fn clipboard_token(app: &AppHandle) -> Option<String> {
    on_main(app, |_| {
        NSPasteboard::generalPasteboard()
            .dataForType(&NSString::from_str(PAYLOAD_TYPE))
            .and_then(|data| ClipboardPayload::decode(&data.to_vec()))
            .map(|payload| payload.token)
    })
    .ok()
    .flatten()
}

/// Publish the payload plus Finder-compatible file URLs for `files`.
pub fn write_clipboard(
    app: &AppHandle,
    payload: ClipboardPayload,
    files: Vec<PathBuf>,
    expected_token: Option<String>,
) -> Result<bool, NativeError> {
    on_main(app, move |_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        if let Some(expected) = expected_token {
            // Staging finished: publish only if nobody replaced our clipboard.
            let current = pasteboard
                .dataForType(&NSString::from_str(PAYLOAD_TYPE))
                .and_then(|data| ClipboardPayload::decode(&data.to_vec()));
            if current.is_none_or(|current| current.token != expected) {
                return Ok(false);
            }
        }
        write_items(&pasteboard, &payload, &files)
    })?
}

/// Write the payload and file URLs as pasteboard items: one item per file
/// (public.file-url, which Finder pastes), plus the Vesperwind payload and a
/// plain-text path list on the first item.
fn write_items(
    pasteboard: &NSPasteboard,
    payload: &ClipboardPayload,
    files: &[PathBuf],
) -> Result<bool, NativeError> {
    let payload_type = NSString::from_str(PAYLOAD_TYPE);
    let encoded = NSData::with_bytes(&payload.encode());
    let text = NSString::from_str(
        &if files.is_empty() {
            payload
                .items
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>()
        } else {
            files
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        }
        .join("\n"),
    );
    let mut items: Vec<Retained<NSPasteboardItem>> = vec![];
    for path in files {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let item = NSPasteboardItem::new();
        let Some(value) = url.absoluteString() else {
            continue;
        };
        // SAFETY: AppKit's file URL pasteboard type constant.
        item.setString_forType(&value, unsafe { NSPasteboardTypeFileURL });
        items.push(item);
    }
    if items.is_empty() {
        items.push(NSPasteboardItem::new());
    }
    items[0].setData_forType(&encoded, &payload_type);
    // SAFETY: AppKit's plain text pasteboard type constant.
    items[0].setString_forType(&text, unsafe { NSPasteboardTypeString });
    let writers: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
        .into_iter()
        .map(ProtocolObject::from_retained)
        .collect();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&NSArray::from_retained_slice(&writers)) {
        Ok(true)
    } else {
        Err(NativeError::new(
            "ECLIPBOARD",
            "macOS rejected the clipboard contents",
        ))
    }
}

/// Clear the general pasteboard only while it still holds `token`.
pub fn clear_clipboard(app: &AppHandle, token: &str) {
    let token = token.to_string();
    let _ = on_main(app, move |_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        let owned = pasteboard
            .dataForType(&NSString::from_str(PAYLOAD_TYPE))
            .and_then(|data| ClipboardPayload::decode(&data.to_vec()))
            .is_some_and(|payload| payload.token == token);
        if owned {
            pasteboard.clearContents();
        }
    });
}

/// Files of the drag that just entered or dropped on the WebView. With
/// Tauri's file-drop handler disabled (so HTML5 drag and drop works inside
/// Vesperwind), WebKit gives the page File objects without paths; the drag
/// pasteboard still holds the real file URLs.
pub fn read_drop(app: &AppHandle) -> Result<Vec<ClipboardFileRef>, NativeError> {
    on_main(app, |_| {
        // SAFETY: AppKit's drag pasteboard name constant.
        let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
        file_refs(&pasteboard)
    })
}

// ---------------------------------------------------------------------------
// Outbound drag sessions

struct PromiseIvars {
    files: ProviderFiles,
    item: DragItem,
}

define_class!(
    /// NSFilePromiseProvider delegate for one SFTP item. Finder tells us the
    /// destination; content streams there from the SFTP provider. No full
    /// download happens before the drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = AllocAnyThread]
    #[ivars = PromiseIvars]
    struct VesperwindPromiseDelegate;

    unsafe impl NSObjectProtocol for VesperwindPromiseDelegate {}

    unsafe impl NSFilePromiseProviderDelegate for VesperwindPromiseDelegate {
        #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
        fn file_name(
            &self,
            _provider: &NSFilePromiseProvider,
            _file_type: &NSString,
        ) -> Retained<NSString> {
            let name = transfer::safe_component(&self.ivars().item.name)
                .unwrap_or_else(|_| "Untitled".into());
            NSString::from_str(&name)
        }

        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn write_promise(
            &self,
            _provider: &NSFilePromiseProvider,
            url: &NSURL,
            completion: &block2::DynBlock<dyn Fn(*mut NSError)>,
        ) {
            let result = url
                .path()
                .ok_or_else(|| NativeError::new("EINVAL", "Finder supplied an invalid destination"))
                .and_then(|path| self.download(&PathBuf::from(path.to_string()), url));
            match result {
                Ok(()) => completion.call((std::ptr::null_mut(),)),
                Err(error) => {
                    emit("native-drag:error", serde_json::json!({ "error": error }));
                    let code = if error.code == "ECANCELLED" {
                        3072
                    } else {
                        512
                    };
                    // SAFETY: Foundation's Cocoa error domain constant.
                    let ns_error = unsafe {
                        NSError::errorWithDomain_code_userInfo(NSCocoaErrorDomain, code, None)
                    };
                    completion.call((Retained::as_ptr(&ns_error) as *mut NSError,));
                }
            }
        }

        #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
        fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
            promise_queue()
        }
    }
);

impl VesperwindPromiseDelegate {
    fn new(files: ProviderFiles, item: DragItem) -> Retained<Self> {
        let this = Self::alloc().set_ivars(PromiseIvars { files, item });
        unsafe { msg_send![super(this), init] }
    }

    /// Runs on the promise operation queue, not the main thread.
    fn download(&self, destination: &Path, url: &NSURL) -> Result<(), NativeError> {
        let item = &self.ivars().item;
        let files = &self.ivars().files;
        let cancel = Arc::new(AtomicBool::new(false));
        let entries = transfer::walk(files, &item.provider_id, &item.path, &cancel)?;
        let total: u64 = entries.iter().map(|entry| entry.size).sum();
        // A published file progress shows Finder's progress and Cancel UI.
        let progress = NSProgress::discreteProgressWithTotalUnitCount(total.max(1) as i64);
        progress.setFileURL(Some(url));
        // SAFETY: Foundation's documented progress kind constants.
        unsafe {
            progress.setKind(Some(NSProgressKindFile));
            progress.setFileOperationKind(Some(NSProgressFileOperationKindDownloading));
        }
        progress.setCancellable(true);
        let flag = Arc::clone(&cancel);
        let handler = RcBlock::new(move || flag.store(true, Ordering::Release));
        // SAFETY: the block is 'static and only touches an Arc<AtomicBool>.
        unsafe { progress.setCancellationHandler(Some(&handler)) };
        progress.publish();
        let mut done = 0i64;
        let result = transfer::download_entries(
            files,
            &item.provider_id,
            entries,
            destination,
            &cancel,
            &mut |bytes| {
                done += bytes as i64;
                progress.setCompletedUnitCount(done);
            },
        );
        progress.unpublish();
        result
    }
}

fn promise_queue() -> Retained<NSOperationQueue> {
    static QUEUE: OnceLock<Retained<NSOperationQueue>> = OnceLock::new();
    QUEUE
        .get_or_init(|| {
            let queue = NSOperationQueue::new();
            queue.setName(Some(ns_string!("com.vesperwind.file-promises")));
            // A few concurrent items; each streams in bounded chunks.
            queue.setMaxConcurrentOperationCount(3);
            queue
        })
        .clone()
}

struct SourceIvars {
    view: Retained<NSView>,
    handled: Cell<bool>,
}

define_class!(
    /// Drag source for Vesperwind items. Outside the app only Copy is
    /// offered: dropping onto Finder never removes the original.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SourceIvars]
    struct VesperwindDragSource;

    unsafe impl NSObjectProtocol for VesperwindDragSource {}

    unsafe impl NSDraggingSource for VesperwindDragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation_mask(
            &self,
            _session: &NSDraggingSession,
            context: NSDraggingContext,
        ) -> NSDragOperation {
            if context == NSDraggingContext::WithinApplication {
                NSDragOperation::Copy
                    | NSDragOperation::Move
                    | NSDragOperation::Link
                    | NSDragOperation::Generic
            } else {
                NSDragOperation::Copy
            }
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(
            &self,
            _session: &NSDraggingSession,
            screen_point: NSPoint,
            operation: NSDragOperation,
        ) {
            let view = &self.ivars().view;
            if !self.ivars().handled.get() {
                // WebKit refused the drop on our own window: resolve it as an
                // internal drop at the release point.
                if let Some(point) = view_point_from_screen(view, screen_point) {
                    emit(
                        "native-drag:drop",
                        serde_json::json!({ "x": point.x, "y": point.y }),
                    );
                }
            }
            emit(
                "native-drag:end",
                serde_json::json!({ "operation": operation.0 }),
            );
            release_mouse(view, screen_point);
            ACTIVE_SOURCE.with(|active| active.borrow_mut().take());
        }
    }
);

thread_local! {
    static ACTIVE_SOURCE: RefCell<Option<Retained<VesperwindDragSource>>> = const { RefCell::new(None) };
    /// Promise delegates are weak in NSFilePromiseProvider; keep the most
    /// recent sessions' delegates alive while Finder may still write.
    static PROMISE_DELEGATES: RefCell<Vec<Vec<Retained<VesperwindPromiseDelegate>>>> = const { RefCell::new(Vec::new()) };
}

fn view_point_from_screen(view: &NSView, screen: NSPoint) -> Option<NSPoint> {
    let window = view.window()?;
    let in_window = window.convertPointFromScreen(screen);
    view_point(view, in_window)
}

fn view_point(view: &NSView, in_window: NSPoint) -> Option<NSPoint> {
    let mut point = view.convertPoint_fromView(in_window, None);
    let bounds = view.bounds();
    if !view.isFlipped() {
        point.y = bounds.size.height - point.y;
    }
    (point.x >= 0.0
        && point.y >= 0.0
        && point.x <= bounds.size.width
        && point.y <= bounds.size.height)
        .then_some(point)
}

/// AppKit's drag loop consumes the mouse-up, so WebKit would keep thinking the
/// button is pressed. Deliver a matching mouse-up to the WebView.
fn release_mouse(view: &NSView, screen_point: NSPoint) {
    let Some(window) = view.window() else {
        return;
    };
    let location = window.convertPointFromScreen(screen_point);
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseUp,
        location,
        objc2_app_kit::NSEventModifierFlags(0),
        0.0,
        window.windowNumber(),
        None,
        0,
        1,
        0.0,
    );
    if let Some(event) = event {
        view.mouseUp(&event);
    }
}

/// Drops of our own session onto the WebView are handled natively, so WebKit
/// never receives (and never materializes) file promises from ourselves.
/// WebKit still sees enter/update, so the page shows normal drop feedback.
fn install_drop_interceptor(view: &NSView) {
    type PerformDrag =
        unsafe extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>) -> Bool;
    static ORIGINAL: OnceLock<PerformDrag> = OnceLock::new();

    unsafe extern "C-unwind" fn perform(
        this: &AnyObject,
        selector: Sel,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> Bool {
        let ours = ACTIVE_SOURCE.with(|active| {
            let active = active.borrow();
            let source = info.draggingSource();
            match (active.as_ref(), source) {
                (Some(active), Some(source)) => std::ptr::eq(
                    Retained::as_ptr(active) as *const AnyObject,
                    Retained::as_ptr(&source),
                )
                .then(|| active.clone()),
                _ => None,
            }
        });
        if let Some(active) = ours {
            active.ivars().handled.set(true);
            // SAFETY: `this` is the WebView instance the method is called on.
            let view: &NSView = unsafe { &*(this as *const AnyObject as *const NSView) };
            if let Some(point) = view_point(view, info.draggingLocation()) {
                emit(
                    "native-drag:drop",
                    serde_json::json!({ "x": point.x, "y": point.y }),
                );
            }
            return Bool::YES;
        }
        match ORIGINAL.get() {
            // SAFETY: the stored IMP is the class's previous implementation of
            // this exact selector and signature.
            Some(original) => unsafe { original(this, selector, info) },
            None => Bool::NO,
        }
    }

    if ORIGINAL.get().is_some() {
        return;
    }
    let class = view.class();
    let Some(method) = class.instance_method(sel!(performDragOperation:)) else {
        return;
    };
    // SAFETY: the replacement has the exact `performDragOperation:` signature
    // (BOOL, id<NSDraggingInfo>). This runs once on the main thread, before
    // any drag session of ours exists, and the previous IMP is kept for all
    // drags that are not ours (including Finder drops into the page).
    unsafe {
        let previous = method
            .set_implementation(std::mem::transmute::<PerformDrag, objc2::runtime::Imp>(
                perform,
            ));
        let _ = ORIGINAL.set(std::mem::transmute::<objc2::runtime::Imp, PerformDrag>(
            previous,
        ));
    }
}

fn drag_image(mtm: MainThreadMarker, item: &DragItem) -> Retained<objc2_app_kit::NSImage> {
    let _ = mtm;
    let workspace = NSWorkspace::sharedWorkspace();
    if item.provider_id == "local" {
        return workspace.iconForFile(&NSString::from_str(&item.path));
    }
    let kind = if item.is_directory {
        "public.folder".to_string()
    } else {
        Path::new(&item.name)
            .extension()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "public.data".into())
    };
    #[allow(deprecated)]
    workspace.iconForFileType(&NSString::from_str(&kind))
}

/// Start an AppKit drag session for `items` from the current mouse event.
pub fn start_drag(
    app: &AppHandle,
    items: Vec<DragItem>,
    files: ProviderFiles,
) -> Result<(), NativeError> {
    let webview = app
        .get_webview("main")
        .ok_or_else(|| NativeError::new("ENATIVE", "The main window is unavailable"))?;
    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| NativeError::new("ENATIVE", "Not on the main thread"))?;
                // SAFETY: Tauri passes the live WKWebView pointer for this webview.
                let view: Retained<NSView> =
                    unsafe { Retained::retain(platform.inner().cast::<NSView>()) }
                        .ok_or_else(|| NativeError::new("ENATIVE", "The WebView is unavailable"))?;
                let event = NSApplication::sharedApplication(mtm)
                    .currentEvent()
                    .filter(|event| {
                        matches!(
                            event.r#type(),
                            NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged
                        )
                    })
                    .ok_or_else(|| {
                        NativeError::new(
                            "EDRAG_ENDED",
                            "The mouse button was released before the drag started",
                        )
                    })?;
                install_drop_interceptor(&view);
                let origin = view.convertPoint_fromView(event.locationInWindow(), None);
                let mut delegates = vec![];
                let mut dragging_items = vec![];
                for (index, item) in items.iter().enumerate() {
                    let writer: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
                        if item.provider_id == "local" {
                            ProtocolObject::from_retained(NSURL::fileURLWithPath(
                                &NSString::from_str(&item.path),
                            ))
                        } else {
                            let delegate =
                                VesperwindPromiseDelegate::new(files.clone(), item.clone());
                            let file_type = if item.is_directory {
                                "public.folder"
                            } else {
                                "public.data"
                            };
                            let provider = NSFilePromiseProvider::initWithFileType_delegate(
                                NSFilePromiseProvider::alloc(),
                                &NSString::from_str(file_type),
                                ProtocolObject::from_ref(&*delegate),
                            );
                            delegates.push(delegate);
                            ProtocolObject::from_retained(provider)
                        };
                    let dragging =
                        NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &writer);
                    let offset = (index.min(4) as f64) * 6.0;
                    let frame = NSRect::new(
                        NSPoint::new(origin.x - 16.0 + offset, origin.y - 16.0 + offset),
                        NSSize::new(32.0, 32.0),
                    );
                    let image = drag_image(mtm, item);
                    // SAFETY: an NSImage is a valid dragging frame content.
                    unsafe { dragging.setDraggingFrame_contents(frame, Some(&image)) };
                    dragging_items.push(dragging);
                }
                let source = VesperwindDragSource::alloc(mtm).set_ivars(SourceIvars {
                    view: view.clone(),
                    handled: Cell::new(false),
                });
                let source: Retained<VesperwindDragSource> =
                    unsafe { msg_send![super(source), init] };
                ACTIVE_SOURCE.with(|active| *active.borrow_mut() = Some(source.clone()));
                PROMISE_DELEGATES.with(|kept| {
                    let mut kept = kept.borrow_mut();
                    kept.push(delegates);
                    let excess = kept.len().saturating_sub(16);
                    kept.drain(..excess);
                });
                let session = view.beginDraggingSessionWithItems_event_source(
                    &NSArray::from_retained_slice(&dragging_items),
                    &event,
                    ProtocolObject::from_ref(&*source),
                );
                session.setAnimatesToStartingPositionsOnCancelOrFail(false);
                session.setDraggingFormation(NSDraggingFormation::Pile);
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| {
            NativeError::new("ENATIVE", "Unable to reach the WebView")
                .with_native_error(error.to_string())
        })?;
    receiver
        .recv()
        .map_err(|_| NativeError::new("ENATIVE", "The drag did not start"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_integration::clipboard::{ClipboardManager, ClipboardOperation};

    /// Uses a private, uniquely named pasteboard: the user's clipboard is
    /// never touched. Run with `cargo test pasteboard -- --ignored`.
    #[test]
    #[ignore]
    fn pasteboard_round_trip_publishes_finder_file_urls() {
        let root = std::env::temp_dir().join(format!("vesperwind-pb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Папка с пробелом")).unwrap();
        std::fs::write(root.join("a 'b' #1.txt"), b"x").unwrap();
        let files = vec![root.join("a 'b' #1.txt"), root.join("Папка с пробелом")];
        let manager = ClipboardManager::new("test".into());
        let payload = manager
            .set(
                ClipboardOperation::Cut,
                files.iter().filter_map(|path| local_ref(path)).collect(),
            )
            .unwrap();
        let pasteboard = NSPasteboard::pasteboardWithUniqueName();
        assert!(write_items(&pasteboard, &payload, &files).unwrap());
        let system = read_pasteboard(&pasteboard);
        assert_eq!(system.payload.as_ref().unwrap().token, payload.token);
        let paths: Vec<_> = system
            .local_files
            .iter()
            .map(|item| item.path.clone())
            .collect();
        let expected: Vec<_> = files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(paths, expected);
        assert!(system.local_files[1].is_directory);
        let snapshot = manager.resolve(Some(system)).unwrap();
        assert_eq!(snapshot.operation, ClipboardOperation::Cut);
        let _: () = unsafe { msg_send![&*pasteboard, releaseGlobally] };
        std::fs::remove_dir_all(root).unwrap();
    }
}
