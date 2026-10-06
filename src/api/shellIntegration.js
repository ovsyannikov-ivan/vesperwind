import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { runtime } from './runtime.js'

// The file clipboard, external drag and drop and disk images. The native
// backend owns platform details (NSPasteboard, OLE, file promises); the UI
// sees only `{ providerId, path }` items and Copy/Cut operations.

const unsupported = (message) => ({ ok: false, error: { code: 'ENOTSUPPORTED', message } })
const nativeBackend = () => backendRuntimeMode === 'tauri'

// Browser/SEA runtimes keep a Vesperwind-only clipboard (no system clipboard),
// with the same Copy/Cut semantics as the native backend.
let memoryClipboard = null
const memoryToken = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`

const write = async (operation, items) => {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: { code: 'EINVAL', message: 'Select at least one item' } }
  }
  if (!nativeBackend()) {
    memoryClipboard = { token: memoryToken(), operation, items: items.map((item) => ({ ...item })), source: 'vesperwind' }
    return { ok: true, clipboard: { ...memoryClipboard, systemClipboard: false, staging: false } }
  }
  return normalizeApiResponse(
    await backend.request('clipboard:write', { operation, items }),
    'ECLIPBOARD', 'Unable to copy the items to the clipboard',
  )
}

const read = async () => {
  if (!nativeBackend()) return { ok: true, clipboard: memoryClipboard }
  return normalizeApiResponse(
    await backend.request('clipboard:read'),
    'ECLIPBOARD', 'Unable to read the clipboard',
  )
}

const consume = async ({ token = null, operation }) => {
  if (!nativeBackend()) {
    if (operation === 'cut' && memoryClipboard?.token === token) memoryClipboard = null
    return { ok: true }
  }
  return normalizeApiResponse(
    await backend.request('clipboard:consume', { token, operation }),
    'ECLIPBOARD', 'Unable to update the clipboard',
  )
}

export const fileClipboard = Object.freeze({
  copyFiles: (items) => write('copy', items),
  cutFiles: (items) => write('cut', items),
  read,
  consume,
})

const dropId = () => globalThis.crypto.randomUUID()

/**
 * Resolve Finder/Explorer files dropped onto the page into local paths.
 * WebKit (macOS) exposes them on the drag pasteboard; WebView2 (Windows)
 * hands the File objects to the host with postMessageWithAdditionalObjects.
 */
const readDrop = async (dataTransfer) => {
  if (!nativeBackend() || !runtime.capabilities.externalFileDrop) {
    return unsupported('Dropping files from other applications needs the desktop app')
  }
  const files = Array.from(dataTransfer?.files || [])
  const payload = { expectedCount: files.length, names: files.map((file) => file.name) }
  const webview = globalThis.chrome?.webview
  if (typeof webview?.postMessageWithAdditionalObjects === 'function') {
    payload.id = dropId()
    webview.postMessageWithAdditionalObjects({ vesperwindFileDrop: payload.id }, dataTransfer.files)
  }
  return normalizeApiResponse(
    await backend.request('drop:read', payload, { timeout: 10_000 }),
    'EDROP_UNAVAILABLE', 'The dropped items could not be read',
  )
}

const startDrag = async (items) => {
  if (!nativeBackend() || !runtime.capabilities.externalDragOut) {
    return unsupported('Dragging to other applications needs the desktop app')
  }
  return normalizeApiResponse(
    await backend.request('drag:start', { items }),
    'EDRAG', 'Unable to start dragging',
  )
}

const diskImage = async (action, fileRef) => {
  if (!nativeBackend() || !runtime.capabilities.mountDiskImage) {
    return unsupported('Disk images can be mounted only in the desktop app')
  }
  return normalizeApiResponse(
    await backend.request('disk-image:operate', {
      action, filesystemId: fileRef?.providerId, path: fileRef?.path,
    }, { timeout: action === 'status' ? 30_000 : 16 * 60_000 }),
    'EDISK_IMAGE', 'The disk image operation failed',
  )
}

export const externalFiles = Object.freeze({ readDrop, startDrag })

export const diskImages = Object.freeze({
  status: (fileRef) => diskImage('status', fileRef),
  mount: (fileRef) => diskImage('mount', fileRef),
  unmount: (fileRef) => diskImage('unmount', fileRef),
})

/** Native events: clipboard:staging, clipboard:consumed, native-drag:*. */
export const onShellEvent = (eventName, callback) => backend.subscribe(eventName, callback)
