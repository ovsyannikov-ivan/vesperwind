import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { permissionMatrix, matrixMode, parseOctal, modeOctal, symbolicMode, permissionChanges } from '../src/utils/permissions.js'
import { canOpenProperties, propertiesShortcutLabel } from '../src/utils/propertiesKeyboard.js'
import { useProperties } from '../src/composables/useProperties.js'
import { createSizeClient } from '../src/api/filesystemSize.js'
import { remoteProperties, sparseSftpUpdate, calculateMetadataSize, readLocalProperties } from '../server/properties.js'

const metadata = (patch = {}) => ({ name: 'report.txt', path: '/files/report.txt', type: 'file', size: 17, createdAt: null, modifiedAt: '2026-01-01T00:00:00Z',
  permissions: { mode: 0o100640, uid: 1000, gid: 1001 }, capabilities: { changeMode: true, changeOwner: true, changeGroup: true, calculateSize: false, preview: true }, ...patch })
const context = { node: { name: 'report.txt', path: '/files/report.txt', size: 17 }, filesystemId: 'sftp:fixture' }
const fakeIO = (properties = metadata()) => ({ properties: async () => ({ ok: true, properties }), updateProperties: async () => ({ ok: true, properties }) })

test('permission matrix round trips rwx and preserves file type and special bits', () => {
  for (let bits = 0; bits < 512; bits++) {
    for (const prefix of [0o100000, 0o040000, 0o120000, 0o107000]) {
      const mode = prefix | bits
      assert.equal(matrixMode(permissionMatrix(mode), mode), mode)
    }
  }
  assert.equal(symbolicMode(0o755), 'rwxr-xr-x')
  assert.equal(symbolicMode(0o4640), 'rwSr-----')
  assert.equal(modeOctal(0o100640), '640')
  assert.equal(parseOctal('750', 0o104640), 0o104750)
  assert.equal(parseOctal('4750', 0o104640), 0o104750)
  for (const invalid of ['7777', '888', '75', '07500', 'abc', '-640', '640 ']) assert.equal(parseOctal(invalid, 0o100640), null)
  assert.deepEqual(permissionChanges(metadata(), { mode: 0o100640, uid: 1000, gid: 1001 }), {})
})
test('platform shortcuts require one entry and yield to text controls, other windows and dialogs', () => {
  const state = { selectedCount: 1, workspaceMode: 'files' }
  const target = { closest: (selector) => selector === '.file-panel.is-active' ? {} : null }
  assert.equal(canOpenProperties({ key: 'i', metaKey: true, target }, state, 'MacIntel'), true)
  assert.equal(propertiesShortcutLabel('MacIntel'), '⌘I'); assert.equal(propertiesShortcutLabel('Win32'), 'Ctrl+I')
  for (const platform of ['Win32', 'Linux']) {
    assert.equal(canOpenProperties({ key: 'Enter', altKey: true, target }, state, platform), true)
    assert.equal(canOpenProperties({ key: 'i', ctrlKey: true, target }, state, platform), true)
    assert.equal(canOpenProperties({ key: 'i', ctrlKey: true, target }, { ...state, selectedCount: 2 }, platform), false)
  }
  for (const patch of [{ selectedCount: 2 }, { selectedCount: 0 }, { blocked: true }, { workspaceMode: 'editor' }, { panelVisible: false }]) {
    assert.equal(canOpenProperties({ key: 'i', metaKey: true, target }, { ...state, ...patch }, 'MacIntel'), false)
  }
  assert.equal(canOpenProperties({ key: 'i', metaKey: true, target: { closest: () => ({}) } }, state, 'MacIntel'), false)
  assert.equal(canOpenProperties({ key: 'i', ctrlKey: true, target }, state, 'MacIntel'), false)
})
test('opening cloud properties reads metadata first, never calculates size or loads preview implicitly', async () => {
  let previews = 0
  const properties = metadata({ contentAvailability: { provider: 'icloud', state: 'cloud' } })
  const state = useProperties({ io: fakeIO(properties), previewLoader: async () => previews++ })
  await state.open(context)
  assert.equal(state.properties.value.size, 17)
  assert.equal(state.canApply.value, false)
  assert.equal(state.cloudPreviewPending.value, true)
  assert.equal(state.preview.value, null)
  assert.equal(state.size.value, null)
  assert.equal(previews, 0)
  await state.loadPreview()
  assert.equal(previews, 1)
  state.close()
  const uncertain = useProperties({ io: fakeIO(metadata({ metadataWarnings: [{ message: 'Cloud metadata is unavailable' }] })), previewLoader: async () => previews++ })
  await uncertain.open(context)
  assert.equal(uncertain.properties.value.size, 17); assert.equal(uncertain.preview.value, null)
  assert.equal(uncertain.previewOnDemand.value, true); assert.equal(previews, 1)
  uncertain.close()
})
test('Apply sends only changed fields, refreshes metadata, and remains open', async () => {
  const updates = [], io = fakeIO(); let changes = 0
  io.updateProperties = async (location, update) => { updates.push([location, update]); return { ok: true, properties: metadata({ permissions: { mode: 0o100750, uid: 1000, gid: 1001 } }) } }
  const state = useProperties({ io, previewLoader: async () => {}, onChanged: () => changes++ })
  await state.open(context)
  assert.equal(state.canApply.value, false)
  state.draft.value.mode = '750'
  assert.equal(state.canApply.value, true)
  await state.apply()
  assert.deepEqual(updates, [[{ providerId: 'sftp:fixture', path: '/files/report.txt' }, { mode: 0o750 }]])
  assert.equal(state.draft.value.mode, '750'); assert.equal(state.canApply.value, false)
  assert.ok(state.current.value); assert.equal(changes, 1)
  state.close()
})
test('cloud video poster/metadata use the shared preparation only after Load Preview', async () => {
  let prepared = 0, thumbnails = 0, probes = 0
  const context = { node: { name: 'movie.mp4', path: '/movie.mp4' }, filesystemId: 'local' }
  const io = fakeIO(metadata({ name: 'movie.mp4', path: '/movie.mp4', contentAvailability: { provider: 'icloud', state: 'cloud' } }))
  const state = useProperties({ io,
    preparePreview: async () => { prepared++; return { ok: true } },
    thumbnail: async () => { thumbnails++; return { ok: true, thumbnail: { status: 'ready', url: 'data:image/jpeg;base64,fixture' } } },
    probe: async () => { probes++; return { ok: true, duration: 7 } },
  })
  await state.open(context); assert.equal(prepared, 0); assert.equal(thumbnails, 0); assert.equal(probes, 0)
  await state.loadPreview(); assert.equal(prepared, 1); assert.equal(thumbnails, 1); assert.equal(probes, 1)
  assert.equal(state.preview.value.mediaMetadata.duration, 7); assert.match(state.preview.value.poster, /^data:/)
  state.close()
})
test('invalid drafts block Apply; denied mutation keeps the modal open and refreshes partial changes', async () => {
  const io = fakeIO(); io.updateProperties = async () => ({ ok: false, error: { code: 'EACCES', message: 'Permission denied' } })
  const state = useProperties({ io, previewLoader: async () => {} })
  await state.open(context)
  state.draft.value.uid = '-1'; assert.equal(state.invalid.value, true); assert.equal(state.canApply.value, false)
  state.draft.value.uid = '2000'; await state.apply()
  assert.ok(state.current.value); assert.equal(state.permissionError.value.message, 'Permission denied')
  assert.equal(state.saving.value, false)
  io.properties = async () => ({ ok: false, error: { code: 'ENOENT', message: 'File no longer exists' } })
  await state.refresh(); state.draft.value.mode = '777'
  assert.ok(state.current.value); assert.equal(state.canApply.value, false); assert.equal(state.error.value.code, 'ENOENT')
  state.close()
})
test('directories never load file preview; Calculate streams partial results and closing cancels the job', async () => {
  let cancelled = 0, callback
  const folder = metadata({ type: 'directory', capabilities: { calculateSize: true, preview: false } })
  const io = fakeIO(folder); io.calculateSize = (_location, cb) => { callback = cb; return { cancel: () => cancelled++ } }
  const state = useProperties({ io, previewLoader: async () => { throw Error('directory preview') } })
  await state.open(context)
  assert.equal(state.preview.value, null); assert.equal(state.sizeState.value, 'idle')
  state.calculate(); assert.equal(state.sizeState.value, 'calculating')
  callback({ progress: { bytes: 123, items: 4, errors: 1 }, done: false })
  assert.equal(state.size.value.bytes, 123)
  state.cancelSize(); assert.equal(cancelled, 1); assert.equal(state.sizeState.value, 'cancelled')
  callback({ progress: { bytes: 999, items: 4, errors: 1 }, done: true }); assert.equal(state.size.value.bytes, 123)
  state.calculate(); state.close(); assert.equal(cancelled, 2)
})
test('closing rejects stale metadata and aborts preview preparation', async () => {
  let resolve, signal
  const state = useProperties({ io: { properties: () => new Promise((r) => { resolve = r }) }, previewLoader: async () => {} })
  const pending = state.open(context); state.close(); resolve({ ok: true, properties: metadata() }); await pending
  assert.equal(state.properties.value, null)
  const previewState = useProperties({ io: fakeIO(), previewLoader: async (_p, options) => { signal = options.signal } })
  await previewState.open(context); previewState.close(); assert.equal(signal.aborted, true)
})
test('unsupported and Windows properties cannot acquire fake writable POSIX fields', async () => {
  const windows = metadata({ permissions: null, capabilities: { preview: true, calculateSize: false, changeMode: false, changeOwner: false, changeGroup: false } })
  const state = useProperties({ io: fakeIO(windows), previewLoader: async () => {} })
  await state.open(context)
  state.draft.value.mode = '777'; state.draft.value.uid = '0'
  assert.equal(state.canApply.value, false); assert.equal(state.properties.value.permissions, null)
  state.close()
  const remote = remoteProperties('/f', { size: 10, mtime: 0 })
  assert.equal(remote.createdAt, null); assert.equal(remote.permissions.mode, null); assert.equal(remote.capabilities.changeMode, false)
  assert.match(remote.permissionsMessage, /not provided/)
})
test('SFTP attributes are numeric and SETSTAT is sparse with a safe ownership pair', () => {
  const attrs = { mode: 0o104640, uid: 1000, gid: 1001, size: 16, mtime: 1, atime: 2 }
  const p = remoteProperties('/f', attrs)
  assert.equal(p.permissions.uid, 1000); assert.equal(p.permissions.ownerName, null); assert.equal(p.createdAt, null)
  assert.deepEqual(sparseSftpUpdate(attrs, { mode: 0o750 }), { mode: 0o104750 })
  assert.deepEqual(sparseSftpUpdate(attrs, { uid: 2000 }), { uid: 2000, gid: 1001 })
  assert.deepEqual(sparseSftpUpdate(attrs, { gid: 2000 }), { uid: 1000, gid: 2000 })
  assert.throws(() => sparseSftpUpdate({ ...attrs, mode: 0o120777 }, { mode: 0o777 }))
  assert.throws(() => sparseSftpUpdate({ ...attrs, gid: undefined }, { uid: 2000 }))
})
test('size client waits for listener readiness, filters job identity and detaches on cancellation', async () => {
  let callback, ready, detached = 0; const requests = [], events = []
  const unsubscribe = () => detached++; unsubscribe.ready = new Promise((r) => { ready = r })
  const transport = { subscribe: (_name, cb) => { callback = cb; return unsubscribe }, request: async (...args) => { requests.push(args); return { ok: true } } }
  const job = createSizeClient(transport)({ providerId: 'sftp:test', path: '/f' }, (e) => events.push(e))
  assert.equal(requests.length, 0); ready(true); await job.started
  callback({ jobId: 'other', done: false }); assert.equal(events.length, 0)
  callback({ jobId: job.jobId, progress: { bytes: 17 }, done: false }); assert.equal(events.length, 1)
  job.cancel(); assert.equal(detached, 1); assert.equal(requests[1][0], 'filesystem:calculate-size-cancel')
  callback({ jobId: job.jobId, done: true }); assert.equal(events.length, 1)
})
test('size backend disconnect ends the job once and prevents launch after listener setup', async () => {
  let connection, ready, callback, detached = 0
  const unsubscribe = () => detached++; unsubscribe.ready = new Promise((r) => { ready = r })
  const requests = [], events = []
  const job = createSizeClient({ subscribe: (_event, cb) => { callback = cb; return unsubscribe },
    subscribeToConnection: (cb) => { connection = cb; return () => detached++ }, request: async (...args) => { requests.push(args); return { ok: true } },
  })({ path: '/folder' }, (event) => events.push(event))
  connection(false); ready(true); await job.started
  callback({ jobId: job.jobId, done: true }); connection(false)
  assert.equal(events.length, 1); assert.equal(events[0].error.code, 'EDISCONNECTED'); assert.equal(detached, 2); assert.equal(requests.length, 0)
})
test('metadata refresh keeps unsaved drafts and rejects older responses', async () => {
  const io = fakeIO(), pending = []
  const state = useProperties({ io, previewLoader: async () => {} })
  await state.open(context)
  state.draft.value.mode = '750'
  io.properties = () => new Promise((resolve) => pending.push(resolve))
  const first = state.refresh({ preserveDraft: true }), second = state.refresh({ preserveDraft: true })
  pending[1]({ ok: true, properties: metadata({ size: 20 }) }); await second
  pending[0]({ ok: true, properties: metadata({ size: 10 }) }); await first
  assert.equal(state.properties.value.size, 20); assert.equal(state.draft.value.mode, '750')
  state.close()
})
test('metadata size counts link entries without traversal, retains partial results and cancels', async () => {
  const controller = new AbortController(), visits = []
  const children = async (p) => { visits.push(p); if (p === '/root/denied') throw Error('denied'); return p === '/root' ? [
    { path: '/root/sub', type: 'directory' }, { path: '/root/denied', type: 'directory' }, { path: '/outside', type: 'symlink', size: 8 }, { path: '/root/cloud', type: 'file', size: 1024 },
  ] : [{ path: '/root/sub/file', type: 'file', size: 19 }] }
  const result = await calculateMetadataSize({ root: '/root', children, signal: controller.signal, onProgress: () => {} })
  assert.deepEqual(result, { bytes: 1051, items: 5, errors: 1, cancelled: false }); assert.ok(!visits.includes('/outside'))
  controller.abort(); assert.equal((await calculateMetadataSize({ root: '/root', children, signal: controller.signal, onProgress: () => {} })).cancelled, true)
})
test('local browser metadata inspects a broken link without following its target', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.properties-test-'))
  try {
    const link = path.join(root, 'link'); await fs.symlink('/missing/target', link)
    const p = await readLocalProperties(link)
    assert.equal(p.type, 'symlink'); assert.equal(p.target, '/missing/target'); assert.equal(p.capabilities.preview, false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('UI contract keeps two columns, generic metadata, capabilities and single-page PDF/PPTX controls', async () => {
  const source = (p) => fs.readFile(new URL(`../${p}`, import.meta.url), 'utf8')
  const [modal, preview, pdf, menu, manager] = await Promise.all(['src/components/PropertiesModal.vue', 'src/components/FilePreview.vue', 'src/components/PdfViewer.vue', 'src/components/FileEntryContextMenu.vue', 'src/components/FileManager.vue'].map(source))
  assert.match(modal, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/)
  for (const field of ['name', 'path', 'size', 'createdAt', 'modifiedAt']) assert.match(modal, new RegExp(`p\\.${field}`))
  assert.match(modal, /p.type === 'directory'/); assert.match(modal, /v-else-if="state.preview.value"/)
  assert.match(modal, /:disabled="!state.canApply.value"/); assert.doesNotMatch(modal, /QuickLookModal|invoke\(/)
  assert.match(modal, /p.capabilities.changeMode/); assert.match(modal, /UID/); assert.match(modal, /GID/)
  assert.match(modal, /Boolean\(p.value\?\.permissions\) \|\| runtime.mode === 'tauri'/)
  assert.match(modal, /v-if="showPermissions" aria-labelledby="properties-permissions"/)
  assert.match(preview, /\['pdf', 'presentation'\]/); assert.match(preview, /:compact="compact"/)
  assert.match(pdf, /v-for="page in displayPages"/); assert.match(pdf, /aria-label="Previous page"/); assert.match(pdf, /aria-label="Next page"/)
  assert.match(menu, /v-if="propertiesAvailable"/); assert.match(menu, /\$emit\('properties'\)/)
  assert.match(manager, /contextEntries\(entryContextRequest, true\).length === 1/); assert.match(manager, /canOpenProperties\(event/)
  const tree = await source('src/components/FileTreeNode.vue')
  assert.match(tree, /event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey/)
})
