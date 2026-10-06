import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  canOfferDiskImage,
  clipboardShortcutLabels,
  copyName,
  fileClipboardShortcut,
  isCutEntry,
  isTextEditingTarget,
  pasteBlockReason,
  planPaste,
} from '../src/utils/fileClipboard.js'
import { normalizeCapabilities } from '../src/api/runtime.js'
import { externalFiles, diskImages, fileClipboard } from '../src/api/shellIntegration.js'
import { beginNativeDrag, endNativeDrag, nativeDropTarget } from '../src/utils/nativeDragSession.js'
import { fileDropKind } from '../src/utils/fileDrop.js'
import { FILE_ENTRY_MIME } from '../src/utils/fileDrag.js'

const target = (closestMatch = null, extra = {}) => ({ closest: (selector) => closestMatch && selector.includes(closestMatch) ? {} : null, ...extra })
const key = (key, modifiers = {}, element = target()) => ({ key, target: element, ...modifiers })
const local = (path, isDirectory = false) => ({ providerId: 'local', path, name: path.split('/').pop(), isDirectory })
const remote = (path, isDirectory = false) => ({ ...local(path, isDirectory), providerId: 'sftp:server' })

test('platform shortcuts and labels: Cmd on macOS, Ctrl on Windows', () => {
  assert.equal(fileClipboardShortcut(key('c', { metaKey: true }), 'MacIntel'), 'copy')
  assert.equal(fileClipboardShortcut(key('X', { metaKey: true }), 'MacIntel'), 'cut')
  assert.equal(fileClipboardShortcut(key('v', { ctrlKey: true }), 'MacIntel'), null)
  assert.equal(fileClipboardShortcut(key('v', { ctrlKey: true }), 'Win32'), 'paste')
  // Russian layout: key is Cyrillic, the physical key decides.
  assert.equal(fileClipboardShortcut(key('м', { metaKey: true, code: 'KeyV' }), 'MacIntel'), 'paste')
  assert.equal(fileClipboardShortcut(key('с', { ctrlKey: true, code: 'KeyC' }), 'Win32'), 'copy')
  assert.equal(fileClipboardShortcut(key('c', { metaKey: true }), 'Win32'), null)
  assert.equal(fileClipboardShortcut(key('c', { ctrlKey: true, shiftKey: true }), 'Win32'), null)
  assert.deepEqual(clipboardShortcutLabels('MacIntel'), { cut: '⌘X', copy: '⌘C', paste: '⌘V' })
  assert.deepEqual(clipboardShortcutLabels('Win32'), { cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V' })
})

test('text editors keep their own Cut/Copy/Paste', () => {
  for (const editor of ['input', 'textarea', '.monaco-editor', '.xterm', '[contenteditable="true"]', '.ProseMirror']) {
    assert.equal(isTextEditingTarget(target(editor)), true, editor)
    assert.equal(fileClipboardShortcut(key('c', { ctrlKey: true }, target(editor)), 'Win32'), null, editor)
  }
  assert.equal(isTextEditingTarget({ isContentEditable: true }), true)
  assert.equal(isTextEditingTarget(target()), false)
})

test('paste plans: Cut moves, Copy copies, and cross-provider items keep their provider', () => {
  const cut = planPaste({ operation: 'cut', token: 't1', items: [local('/a/x.txt'), remote('/srv/d', true)] }, local('/b', true))
  assert.equal(cut.ok, true)
  assert.equal(cut.action, 'move')
  assert.equal(cut.consumes, true)
  assert.equal(cut.token, 't1')
  assert.deepEqual(cut.sources.map((s) => s.providerId), ['local', 'sftp:server'])
  const copy = planPaste({ operation: 'copy', items: [remote('/srv/a.bin')] }, remote('/srv/out', true))
  assert.equal(copy.action, 'copy')
  assert.equal(copy.consumes, false)
})

test('paste into the source folder copies with a free name and never into itself', () => {
  const plan = planPaste({ operation: 'copy', items: [local('/a/report.txt'), local('/a/Folder', true)] }, local('/a', true),
    ['report.txt', 'report copy.txt', 'Folder'])
  assert.deepEqual(plan.sources.map((s) => s.targetName), ['report copy 2.txt', 'Folder copy'])
  assert.equal(copyName('archive.tar.gz', false, ['archive.tar.gz']), 'archive.tar copy.gz')
  assert.equal(copyName('.env', false, ['.env']), '.env copy')
  assert.match(pasteBlockReason({ operation: 'copy', items: [local('/a', true)] }, local('/a/b', true)), /into itself/)
  assert.match(pasteBlockReason({ operation: 'cut', items: [local('/a/x')] }, local('/a', true)), /already in this folder/)
  assert.equal(pasteBlockReason({ operation: 'copy', items: [remote('/a', true)] }, local('/a/b', true)), null)
  assert.match(pasteBlockReason(null, local('/a', true)), /does not contain/)
  assert.match(pasteBlockReason({ operation: 'copy', items: [local('/x')] }, { providerId: 'local', path: 'computer://', isDirectory: true }), /Choose a folder/)
})

test('selected descendants are not transferred twice', () => {
  const plan = planPaste({ operation: 'copy', items: [local('/a', true), local('/a/b.txt')] }, local('/c', true))
  assert.deepEqual(plan.sources.map((s) => s.path), ['/a'])
})

test('only a Vesperwind Cut dims rows', () => {
  const item = local('/a/x')
  assert.equal(isCutEntry({ operation: 'cut', source: 'vesperwind', items: [item] }, item), true)
  assert.equal(isCutEntry({ operation: 'cut', source: 'system', items: [item] }, item), false)
  assert.equal(isCutEntry({ operation: 'copy', source: 'vesperwind', items: [item] }, item), false)
})

test('disk image menu follows backend capabilities, not the file name alone', () => {
  const mac = normalizeCapabilities({ mountDiskImage: true, diskImageExtensions: ['dmg', 'ISO'] })
  const windows = normalizeCapabilities({ mountDiskImage: true, diskImageExtensions: ['iso'] })
  assert.equal(canOfferDiskImage(local('/x/Installer.DMG'), mac), true)
  assert.equal(canOfferDiskImage(local('/x/a.iso'), windows), true)
  assert.equal(canOfferDiskImage(local('/x/a.dmg'), windows), false)
  assert.equal(canOfferDiskImage(remote('/x/a.iso'), mac), false)
  assert.equal(canOfferDiskImage(local('/x/folder.iso', true), mac), false)
  assert.equal(canOfferDiskImage(local('/x/a.iso'), normalizeCapabilities(undefined)), false)
})

test('browser runtime keeps a Vesperwind-only clipboard and reports native features as unavailable', async () => {
  assert.equal((await fileClipboard.read()).clipboard, null)
  const written = await fileClipboard.cutFiles([remote('/srv/a')])
  assert.equal(written.ok, true)
  const { clipboard } = await fileClipboard.read()
  assert.equal(clipboard.operation, 'cut')
  await fileClipboard.consume({ token: 'other', operation: 'cut' })
  assert.notEqual((await fileClipboard.read()).clipboard, null)
  await fileClipboard.consume({ token: clipboard.token, operation: 'cut' })
  assert.equal((await fileClipboard.read()).clipboard, null)
  assert.equal((await fileClipboard.copyFiles([])).ok, false)
  for (const response of [await externalFiles.startDrag([local('/a')]), await diskImages.mount(local('/a.iso'))]) {
    assert.equal(response.error.code, 'ENOTSUPPORTED')
  }
})

test('drop kinds distinguish HTML5, native and Finder/Explorer drags', () => {
  const event = (types) => ({ dataTransfer: { types } })
  assert.equal(fileDropKind(event([FILE_ENTRY_MIME]), {}), 'internal')
  assert.equal(fileDropKind(event(['Files']), { externalFileDrop: true }), 'external')
  assert.equal(fileDropKind(event(['Files']), { externalFileDrop: false }), null)
  beginNativeDrag({ providerId: 'local', path: '/a' })
  assert.equal(fileDropKind(event(['Files']), { externalFileDrop: true }), 'native')
  endNativeDrag()
})

test('native drops resolve rows, panel folders and terminals at the point', () => {
  const element = (matches) => ({ closest: (selector) => matches[selector] || null })
  const panel = { dataset: { panelSide: 'right', providerId: 'sftp:x', currentPath: '/srv', currentName: 'srv' } }
  const row = { dataset: { dropPath: '/srv/in', dropName: 'in' } }
  const doc = (matches) => ({ elementFromPoint: () => element(matches) })
  assert.deepEqual(nativeDropTarget(1, 2, doc({ '[data-panel-side]': panel, '[data-directory-drop-target]': row })), {
    kind: 'directory', targetPanel: 'right', target: { providerId: 'sftp:x', path: '/srv/in', name: 'in', isDirectory: true },
  })
  assert.equal(nativeDropTarget(1, 2, doc({ '[data-panel-side]': panel })).target.path, '/srv')
  assert.equal(nativeDropTarget(1, 2, doc({ '[data-terminal-drop-target]': {} })).kind, 'terminal')
  assert.equal(nativeDropTarget(1, 2, doc({})), null)
})

test('Tauri transport maps shell commands and events; menus expose Cut/Copy/Paste and disk images', async () => {
  const [transport, menu, manager] = await Promise.all([
    fs.readFile(new URL('../src/api/transports/tauri.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/FileEntryContextMenu.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/FileManager.vue', import.meta.url), 'utf8'),
  ])
  for (const [request, command] of [['clipboard:write', 'clipboard_write'], ['clipboard:read', 'clipboard_read'],
    ['clipboard:consume', 'clipboard_consume'], ['drop:read', 'drop_read'], ['drag:start', 'drag_start'],
    ['disk-image:operate', 'disk_image_operate']]) {
    assert.match(transport, new RegExp(`'${request}': '${command}'`))
  }
  for (const event of ['clipboard:staging', 'clipboard:consumed', 'native-drag:drop', 'native-drag:end']) {
    assert.match(transport, new RegExp(`'${event}'`))
  }
  for (const action of ['cut', 'copy', 'paste', 'mount-image', 'unmount-image']) {
    assert.match(menu, new RegExp(`\\$emit\\('${action}'\\)`))
  }
  assert.match(menu, /Mount Disk Image/)
  assert.match(menu, /Eject Disk Image/)
  assert.doesNotMatch(manager + menu, /navigator\.clipboard/)
  assert.match(manager, /if \(handleClipboardShortcut\(event\)\) return/)
})

test('context-menu Delete passes its item as sources (regression: e.filter on undefined)', async () => {
  const manager = await fs.readFile(new URL('../src/components/FileManager.vue', import.meta.url), 'utf8')
  assert.match(manager, /action: 'delete',\s*source: requestDetails\.node,\s*sources: \[requestDetails\.node\],/)
  assert.match(manager, /transferSources\(sources\?\.length \? sources : \[requestDetails\?\.source\]\.filter\(Boolean\)\)/)
})

test('Duplicate sits below Paste under its own divider and copies next to the original', async () => {
  const [menu, manager] = await Promise.all([
    fs.readFile(new URL('../src/components/FileEntryContextMenu.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/FileManager.vue', import.meta.url), 'utf8'),
  ])
  assert.match(menu, /clipboard\.shortcuts\.paste[\s\S]*?<\/button>\s*<div class="dropdown-divider" \/>\s*<button[^>]*\$emit\('duplicate'\)[\s\S]*?Duplicate/)
  assert.match(manager, /copyEntry\(source, source\.targetDirectory \|\| targetDirectory, source\.targetName\)/)
  const plan = planPaste({ operation: 'copy', items: [local('/a/photo.jpg')] }, local('/a', true), ['photo.jpg'])
  assert.equal(plan.sources[0].targetName, 'photo copy.jpg')
})
