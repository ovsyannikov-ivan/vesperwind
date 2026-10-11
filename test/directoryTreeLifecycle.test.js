// Regression tests for the tree state after review of PR #10: branches that
// vanish from a full listing, and lazy cloud status across collapse, refresh,
// deletion, deactivation and two trees.
import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import { createDirectoryTree } from '../src/composables/useDirectoryTree.js'
import { createCloudStatusInspector } from '../src/api/cloudStatus.js'
import { sortAndFilterEntries } from '../src/utils/fileDirectoryView.js'

const settle = async (times = 3) => { for (let index = 0; index < times; index++) await new Promise((resolve) => setTimeout(resolve, 0)) }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const file = (dir, name, extra = {}) => ({ name, path: `${dir}/${name}`, isDirectory: false, size: 1, modifiedAt: '2026-10-11T00:00:00.000Z', ...extra })
const folder = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: true, size: null, modifiedAt: '2026-10-11T00:00:00.000Z' })

// Folders served from memory. `gate(path)` may return a promise that holds a
// listing back; aborted requests and live watchers are recorded.
const fixture = (folders, options = {}) => {
  const calls = []
  const aborted = []
  const watchers = new Map()
  const props = reactive({ providerId: 'local', root: { name: 'root', path: '/root', isDirectory: true }, expandedPaths: [],
    view: { name: '', extensions: [], keepFolders: true, sort: 'name', direction: 'asc' }, watchActive: true, ...options.props })
  const tree = createDirectoryTree({
    getRoot: () => props.root,
    getProviderId: () => props.providerId,
    listDirectory: async (path, { signal } = {}) => {
      calls.push(path)
      signal?.addEventListener('abort', () => aborted.push(path))
      await options.gate?.(path)
      const entries = folders[path]
      if (options.fail?.(path)) return { ok: false, error: { message: 'Offline' } }
      return entries ? { ok: true, entries: entries.map((entry) => ({ ...entry })) } : { ok: false, error: { message: 'Missing' } }
    },
    transformChildren: (entries, depth) => sortAndFilterEntries(entries, props.view, depth),
    getExpandedPaths: () => props.expandedPaths,
    isWatchActive: () => props.watchActive,
    cloudStatus: options.cloudStatus || null,
    statusPriority: options.statusPriority || (() => []),
    watchRegistry: {
      subscribe: (providerId, path, callback) => {
        const key = `${providerId}:${path}`
        watchers.set(key, callback)
        return () => watchers.delete(key)
      },
    },
    onExpandedChange: ({ path, expanded }) => {
      props.expandedPaths = expanded ? [...new Set([...props.expandedPaths, path])] : props.expandedPaths.filter((value) => value !== path)
    },
  })
  const names = () => tree.rows.value.map((row) => `${'  '.repeat(row.depth)}${row.kind === 'entry' ? row.entry.name : `<${row.kind}>`}`)
  const row = (name) => tree.rows.value.find((item) => item.entry?.name === name)
  const refresh = async (path) => { watchers.get(`local:${path}`)(); await settle() }
  return { tree, props, calls, aborted, watchers, names, row, refresh, folders }
}

const documentsTree = () => ({
  '/root': [folder('/root', 'Documents'), folder('/root', 'Downloads'), file('/root', 'a.txt')],
  '/root/Documents': [folder('/root/Documents', 'Projects'), file('/root/Documents', 'notes.md')],
  '/root/Documents/Projects': [file('/root/Documents/Projects', 'plan.md')],
  '/root/Downloads': [file('/root/Downloads', 'x.zip')],
})

const openDocuments = async (h) => {
  h.tree.resetRoot(); await settle()
  h.tree.expand(h.row('Documents').entry, 1); await settle()
  h.tree.expand(h.row('Projects').entry, 2); await settle()
}

test('a folder deleted from the full listing releases its branch, watchers and requests', async () => {
  const gate = deferred()
  let holdProjects = false
  const h = fixture(documentsTree(), { gate: (path) => (holdProjects && path === '/root/Documents/Projects' ? gate.promise : null) })
  await openDocuments(h)
  assert.deepEqual([...h.watchers.keys()].sort(), ['local:/root', 'local:/root/Documents', 'local:/root/Documents/Projects'])
  // A refresh of Projects is still in flight when Documents disappears.
  holdProjects = true
  h.watchers.get('local:/root/Documents/Projects')()
  h.folders['/root'] = h.folders['/root'].filter((entry) => entry.name !== 'Documents')
  await h.refresh('/root')
  assert.equal(h.tree.recordOf('/root/Documents'), undefined)
  assert.equal(h.tree.recordOf('/root/Documents/Projects'), undefined)
  assert.deepEqual([...h.watchers.keys()], ['local:/root'])
  assert.ok(h.aborted.includes('/root/Documents/Projects'), 'the in-flight request was cancelled')
  assert.equal(h.tree.isExpanded('/root/Documents'), false)
  assert.deepEqual(h.props.expandedPaths, [], 'the owner no longer lists the vanished folders as expanded')
  gate.resolve(); await settle()
  assert.equal(h.tree.recordOf('/root/Documents/Projects'), undefined, 'a late response does not restore the branch')
  assert.deepEqual(h.names(), ['root', '  Downloads', '  a.txt'])
  h.tree.dispose()
})

test('a folder recreated under the same name shows its new contents', async () => {
  const h = fixture(documentsTree())
  await openDocuments(h)
  const documents = h.folders['/root'].find((entry) => entry.name === 'Documents')
  h.folders['/root'] = h.folders['/root'].filter((entry) => entry !== documents)
  await h.refresh('/root')
  h.folders['/root'] = [...h.folders['/root'], documents]
  h.folders['/root/Documents'] = [file('/root/Documents', 'new.txt')]
  await h.refresh('/root')
  assert.equal(h.row('Documents').expanded, false, 'the recreated folder starts closed')
  h.tree.expand(h.row('Documents').entry, 1); await settle()
  assert.deepEqual(h.names(), ['root', '  Documents', '    new.txt', '  Downloads', '  a.txt'])
  assert.equal(h.calls.filter((path) => path === '/root/Documents').length, 2, 'a fresh listing, not the old cache')
  h.tree.dispose()
})

test('a folder replaced by a file, and a deleted collapsed folder, are released', async () => {
  const h = fixture(documentsTree())
  await openDocuments(h)
  h.tree.expand(h.row('Downloads').entry, 1); await settle()
  h.tree.collapse('/root/Downloads')
  assert.ok(h.tree.recordOf('/root/Downloads'), 'the collapsed folder is cached')
  h.folders['/root'] = [file('/root', 'Documents'), file('/root', 'a.txt')]
  await h.refresh('/root')
  assert.equal(h.tree.recordOf('/root/Documents'), undefined)
  assert.equal(h.tree.recordOf('/root/Documents/Projects'), undefined)
  assert.equal(h.tree.recordOf('/root/Downloads'), undefined, 'the cached collapsed folder is released too')
  assert.deepEqual(h.names(), ['root', '  a.txt', '  Documents'])
  assert.equal(h.row('Documents').entry.isDirectory, false)
  h.tree.dispose()
})

test('a rename done in Vesperwind reopens the renamed branch with fresh listings', async () => {
  const h = fixture(documentsTree())
  await openDocuments(h)
  // FilePanel relocates expandedPaths on the rename event before the refresh.
  h.props.expandedPaths = ['/root/Docs', '/root/Docs/Projects']
  h.folders['/root'] = [folder('/root', 'Docs'), folder('/root', 'Downloads'), file('/root', 'a.txt')]
  h.folders['/root/Docs'] = [folder('/root/Docs', 'Projects'), file('/root/Docs', 'notes.md')]
  h.folders['/root/Docs/Projects'] = [file('/root/Docs/Projects', 'plan.md')]
  await h.refresh('/root'); await settle()
  assert.equal(h.tree.recordOf('/root/Documents'), undefined)
  assert.deepEqual(h.names(), ['root', '  Docs', '    Projects', '      plan.md', '    notes.md', '  Downloads', '  a.txt'])
  assert.deepEqual([...h.watchers.keys()].sort(), ['local:/root', 'local:/root/Docs', 'local:/root/Docs/Projects'])
  h.tree.dispose()
})

test('an outside rename closes the old branch; the new name appears closed', async () => {
  const h = fixture(documentsTree())
  await openDocuments(h)
  h.folders['/root'] = [folder('/root', 'Archive'), folder('/root', 'Downloads'), file('/root', 'a.txt')]
  await h.refresh('/root')
  assert.deepEqual(h.names(), ['root', '  Archive', '  Downloads', '  a.txt'])
  assert.equal(h.tree.recordOf('/root/Documents'), undefined)
  h.tree.dispose()
})

test('filters, failed refreshes and superseded refreshes never release folder data', async () => {
  let failing = false
  const gate = deferred()
  let holdRoot = false
  const h = fixture(documentsTree(), { fail: (path) => failing && path === '/root',
    gate: (path) => (holdRoot && path === '/root' ? gate.promise : null) })
  await openDocuments(h)
  h.props.view = { ...h.props.view, name: '*.txt' }
  await h.refresh('/root')
  assert.ok(h.tree.recordOf('/root/Documents/Projects'), 'a filtered-out folder keeps its data')
  h.props.view = { ...h.props.view, name: '' }
  assert.ok(h.names().includes('      plan.md'))
  failing = true
  await h.refresh('/root')
  assert.ok(h.tree.recordOf('/root/Documents'), 'a failed refresh is not an empty listing')
  failing = false
  // A refresh superseded by a newer one is ignored even if it would drop Documents.
  holdRoot = true
  const original = h.folders['/root']
  h.folders['/root'] = original.filter((entry) => entry.name !== 'Documents')
  h.watchers.get('local:/root')()
  holdRoot = false
  h.folders['/root'] = original
  await h.refresh('/root')
  gate.resolve(); await settle()
  assert.ok(h.tree.recordOf('/root/Documents/Projects'))
  h.tree.dispose()
})

// A cloud inspector over a controllable backend: every batch waits for the
// test, and requests, cancellations and slot use are recorded.
const cloudBackend = ({ batchSize = 64 } = {}) => {
  const sent = []
  const cancelled = []
  const inspector = createCloudStatusInspector({
    batchSize, concurrency: 2, pause: () => Promise.resolve(), newId: (() => { let id = 0; return () => `r${++id}` })(),
    request: (event, payload) => {
      if (event === 'filesystem:cloud-status-cancel') { cancelled.push(payload.requestId); return Promise.resolve({ ok: true }) }
      assert.equal(event, 'filesystem:cloud-status', 'inspection only asks for metadata; nothing is prepared or downloaded')
      const reply = deferred()
      sent.push({ ...payload, reply })
      return reply.promise
    },
  })
  const answer = (index, statusFor = () => ({ contentAvailability: { state: 'cloud' } })) => {
    const batch = sent[index]
    batch.reply.resolve({ ok: true, statuses: batch.paths.map((path) => ({ path, ...statusFor(path) })) })
  }
  const inFlight = () => sent.filter((batch) => !batch.answered).length
  return { inspector, sent, cancelled, answer, inFlight }
}
const cloudFolder = (count) => ({ '/root': Array.from({ length: count }, (_, index) => file('/root', `f${String(index).padStart(5, '0')}.txt`)) })

test('collapsing mid-scan and reopening from the cache resolves the rest without re-inspecting', async () => {
  const cloud = cloudBackend({ batchSize: 2 })
  const folders = { '/root': [folder('/root', 'cloud')], '/root/cloud': cloudFolder(6)['/root'].map((entry) => ({ ...entry, path: entry.path.replace('/root/', '/root/cloud/') })) }
  const h = fixture(folders, { cloudStatus: cloud.inspector })
  h.tree.resetRoot(); await settle()
  h.tree.expand(h.row('cloud').entry, 1); await settle()
  // One scan sends its batches one after another.
  cloud.answer(0); await settle()
  cloud.answer(1); await settle()
  const first = cloud.sent.slice(0, 2).flatMap((batch) => batch.paths)
  assert.equal(cloud.sent.length, 3, 'the third batch is in flight')
  h.tree.collapse('/root/cloud')
  assert.ok(cloud.cancelled.length, 'collapsing cancels the batch in flight')
  const listings = h.calls.length
  h.tree.expand(h.row('cloud').entry, 1); await settle()
  assert.equal(h.calls.length, listings, 'reopened from the cache')
  const resumed = cloud.sent.slice(3).flatMap((batch) => batch.paths)
  assert.equal(resumed.some((path) => first.includes(path)), false, 'resolved files are not inspected again')
  assert.equal(resumed.length, 2, 'the scan continues with the batch that was cancelled')
  cloud.answer(3); await settle()
  const record = h.tree.recordOf('/root/cloud')
  assert.ok(record.state.children.every((entry) => record.listing.statusOf(entry.path) === 'resolved'), 'nothing stays pending')
  assert.ok(record.state.children.every((entry) => entry.contentAvailability?.state === 'cloud'), 'badges received before collapse are kept')
  h.tree.dispose()
})

test('refresh mid-scan ignores old answers and keeps unchanged badges on the same tree data', async () => {
  const cloud = cloudBackend({ batchSize: 2 })
  const h = fixture(cloudFolder(4), { cloudStatus: cloud.inspector })
  h.tree.resetRoot(); await settle()
  cloud.answer(0); await settle()
  const record = h.tree.recordOf('/root')
  const beforeRows = h.tree.rows.value.length
  h.folders['/root'][3] = { ...h.folders['/root'][3], modifiedAt: '2026-10-12T00:00:00.000Z' }
  await h.refresh('/root')
  const oldBatch = cloud.sent[1]
  oldBatch.reply.resolve({ ok: true, statuses: oldBatch.paths.map((path) => ({ path, contentAvailability: { state: 'failed' } })) })
  await settle()
  const children = record.state.children
  assert.deepEqual(children.slice(0, 2).map((entry) => entry.contentAvailability?.state), ['cloud', 'cloud'], 'unchanged badges carried over')
  assert.ok(children.slice(2).every((entry) => entry.contentAvailability === undefined), 'the old generation never applies')
  // The new scan re-inspects everything once, writing onto the same objects.
  const newBatches = cloud.sent.slice(2)
  assert.deepEqual(newBatches.flatMap((batch) => batch.paths).slice(0, 2), ['/root/f00000.txt', '/root/f00001.txt'])
  cloud.answer(2, () => ({}))
  await settle()
  assert.equal(record.state.children, children, 'children are not replaced by statuses')
  assert.equal(h.tree.rows.value.length, beforeRows)
  h.tree.dispose()
})

test('deleting a scanning branch, deactivating and disposing cancel cloud batches', async () => {
  const cloud = cloudBackend({ batchSize: 2 })
  const folders = { '/root': [folder('/root', 'a'), folder('/root', 'b')],
    '/root/a': [file('/root/a', '1.txt'), file('/root/a', '2.txt'), file('/root/a', '3.txt')],
    '/root/b': [file('/root/b', '1.txt'), file('/root/b', '2.txt'), file('/root/b', '3.txt')] }
  const h = fixture(folders, { cloudStatus: cloud.inspector })
  h.tree.resetRoot(); await settle()
  h.tree.expand(h.row('a').entry, 1); await settle()
  h.tree.expand(h.row('b').entry, 1); await settle()
  assert.equal(cloud.sent.length, 2, 'two batches run at once')
  const [batchA] = cloud.sent
  folders['/root'] = [folder('/root', 'b')]
  await h.refresh('/root')
  assert.ok(cloud.cancelled.includes('r1'), 'the deleted branch cancels its batch')
  batchA.reply.resolve({ ok: true, statuses: batchA.paths.map((path) => ({ path, contentAvailability: { state: 'cloud' } })) })
  await settle()
  h.props.watchActive = false
  h.tree.setWatchActive(false)
  assert.ok(cloud.cancelled.includes('r2'), 'deactivation cancels the scan')
  h.props.watchActive = true
  h.tree.setWatchActive(true); await settle()
  const resumedB = cloud.sent.filter((batch) => batch.directoryPath === '/root/b').length
  assert.ok(resumedB >= 2, 'reactivation refreshes and inspects again')
  const before = cloud.cancelled.length
  h.tree.dispose()
  assert.ok(cloud.cancelled.length > before, 'dispose cancels what is in flight')
})

test('two trees share the two-batch limit and keep their own statuses', async () => {
  const cloud = cloudBackend({ batchSize: 2 })
  const left = fixture(cloudFolder(4), { cloudStatus: cloud.inspector })
  const right = fixture(cloudFolder(4), { cloudStatus: cloud.inspector })
  left.tree.resetRoot(); right.tree.resetRoot(); await settle()
  assert.equal(cloud.sent.length, 2)
  cloud.answer(1, () => ({ contentAvailability: { state: 'materializing' } }))
  await settle()
  assert.equal(cloud.sent.length, 3, 'a slot freed by one tree is taken by the next batch')
  const leftChildren = left.tree.recordOf('/root').state.children
  const rightChildren = right.tree.recordOf('/root').state.children
  assert.notEqual(leftChildren[0], rightChildren[0])
  assert.equal(leftChildren[0].contentAvailability, undefined)
  assert.equal(rightChildren[0].contentAvailability.state, 'materializing')
  right.tree.dispose()
  assert.equal(left.tree.recordOf('/root').listing.statusOf('/root/f00002.txt'), 'pending', 'the other tree keeps scanning')
  left.tree.dispose()
})
