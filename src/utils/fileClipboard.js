import { isComputerPath } from '../../shared/localFilesystem.js'
import { isSameOrDescendantPath, getFilesystemParentPath } from './filesystemPath.js'
import { transferSources } from './fileSelection.js'

export const CLIPBOARD_OPERATIONS = Object.freeze(['copy', 'cut'])

const isMac = (platform) => /Mac|iPhone|iPad/i.test(platform || '')

export const clipboardShortcutLabels = (platform = globalThis.navigator?.platform) => isMac(platform)
  ? { cut: '⌘X', copy: '⌘C', paste: '⌘V' }
  : { cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V' }

// Text editing keeps its own Cut/Copy/Paste: inputs, Monaco, contenteditable
// documents, terminals and any other editor surface.
const TEXT_EDITING_SELECTOR = [
  'input', 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]',
  '.monaco-editor', '.xterm', '[role="textbox"]', '.cm-editor', '.ProseMirror',
  '[data-text-editing]',
].join(', ')

export const isTextEditingTarget = (target) => Boolean(
  target?.isContentEditable || target?.closest?.(TEXT_EDITING_SELECTOR),
)

const MESSAGE_SELECTOR = '.modal, .alert, [role="alert"], .panel-message, .dropdown-menu'
const selectedMessageText = () => {
  const selection = globalThis.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.toString()) return false
  const node = selection.anchorNode
  const element = node?.nodeType === 1 ? node : node?.parentElement
  return Boolean(element?.closest?.(MESSAGE_SELECTOR))
}

/** Platform Cut/Copy/Paste key for file operations, or null. */
export const fileClipboardShortcut = (event, platform = globalThis.navigator?.platform) => {
  if (!event || event.altKey || event.shiftKey || event.repeat) return null
  const modifier = isMac(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier || isTextEditingTarget(event.target)) return null
  // Text deliberately selected in a message or dialog copies as text.
  if (selectedMessageText()) return null
  // Physical keys, so ⌘C/⌘X/⌘V also work with a Russian or other layout,
  // where `key` is "с", "ч" or "м" while the menu shortcut still applies.
  return { KeyX: 'cut', KeyC: 'copy', KeyV: 'paste' }[event.code] ||
    { x: 'cut', c: 'copy', v: 'paste' }[event.key?.toLowerCase()] || null
}

export const clipboardItem = (entry) => ({
  providerId: entry.providerId,
  path: entry.path,
  name: entry.name,
  isDirectory: entry.isDirectory === true,
})

const sameEntry = (left, right) => left.providerId === right.providerId && left.path === right.path

/** Whether a destination folder can receive the clipboard contents. */
export const pasteBlockReason = (snapshot, destination) => {
  if (!snapshot?.items?.length) return 'The clipboard does not contain files or folders'
  if (!destination?.path || destination.isDirectory === false || isComputerPath(destination.path)) {
    return 'Choose a folder to paste into'
  }
  for (const item of snapshot.items) {
    if (item.providerId !== destination.providerId || !item.isDirectory) continue
    if (isSameOrDescendantPath(item.path, destination.path)) {
      return `“${item.name}” cannot be pasted into itself`
    }
  }
  if (snapshot.operation === 'cut' && snapshot.items.every((item) =>
    item.providerId === destination.providerId && getFilesystemParentPath(item.path) === destination.path)) {
    return 'The items are already in this folder'
  }
  return null
}

const splitName = (name, isDirectory) => {
  const dot = isDirectory ? -1 : name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** Finder-style free name: "report copy.txt", "report copy 2.txt", … */
export const copyName = (name, isDirectory, takenNames) => {
  const taken = new Set(takenNames)
  if (!taken.has(name)) return name
  const [stem, extension] = splitName(name, isDirectory)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${stem} copy${index > 1 ? ` ${index}` : ''}${extension}`
    if (!taken.has(candidate)) return candidate
  }
  return null
}

/**
 * Turn a clipboard snapshot into existing filesystem operations.
 * Cut = move (cross-provider moves copy first and delete the source only after
 * success); Copy = copy. A copy into the item's own folder gets a free name.
 */
export const planPaste = (snapshot, destination, destinationNames = []) => {
  const reason = pasteBlockReason(snapshot, destination)
  if (reason) return { ok: false, error: { code: 'EPASTE', message: reason } }
  const action = snapshot.operation === 'cut' ? 'move' : 'copy'
  const taken = [...destinationNames]
  const sources = transferSources(snapshot.items.map(clipboardItem))
    .filter((item) => !(action === 'move' && item.providerId === destination.providerId &&
      getFilesystemParentPath(item.path) === destination.path))
    .map((item) => {
      const sameFolder = item.providerId === destination.providerId &&
        getFilesystemParentPath(item.path) === destination.path
      if (action !== 'copy' || (!sameFolder && !taken.includes(item.name))) {
        taken.push(item.name)
        return item
      }
      // Only a copy within the same folder is renamed automatically; any other
      // existing name is reported by the backend instead of being replaced.
      if (!sameFolder) return item
      const name = copyName(item.name, item.isDirectory, taken)
      taken.push(name)
      return { ...item, targetName: name }
    })
  return {
    ok: true,
    action,
    sources,
    consumes: snapshot.operation === 'cut',
    token: snapshot.token || null,
  }
}

export const isCutEntry = (snapshot, entry) => Boolean(
  snapshot?.operation === 'cut' && snapshot.source === 'vesperwind' &&
  snapshot.items?.some((item) => sameEntry(item, entry)),
)

export const diskImageExtension = (name) => {
  const match = /\.([^./\\]+)$/u.exec(name || '')
  return match ? match[1].toLowerCase() : ''
}

export const canOfferDiskImage = (entry, capabilities) => Boolean(
  capabilities?.mountDiskImage && entry && !entry.isDirectory && entry.providerId === 'local' &&
  capabilities.diskImageExtensions?.includes(diskImageExtension(entry.name)),
)
