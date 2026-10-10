import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, reactive } from 'vue'
import { applyCloudStatus, createDirectoryListing } from '../src/utils/directoryListing.js'
import { cloudStatus as appCloudStatus, createCloudStatusInspector, createLimiter } from '../src/api/cloudStatus.js'
import { getFileStatusBadge } from '../src/utils/contentAvailability.js'
import { sortAndFilterEntries } from '../src/utils/fileDirectoryView.js'
import { DEFAULT_CAPABILITIES, normalizeCapabilities } from '../src/api/runtime.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const file = (directory, name, extra = {}) => ({ name, path: `${directory}/${name}`, isDirectory: false,
  modifiedAt: '2026-10-10T00:00:00.000Z', size: 1, ...extra })
const cloud = { state: 'cloud' }

// A scripted inspector: every scan waits until the test releases its batches.
const scriptedStatus = ({ supported = true } = {}) => {
  const scans = []
  return {
    scans,
    supports: async () => supported,
    inspect: (request) => {
      const scan = { ...request, finished: deferred() }
      scans.push(scan)
      return scan.finished.promise
    },
  }
}

const harness = ({ entries = {}, cloudStatus, location = { providerId: 'local', path: '/a' }, reactiveState = false, ...options } = {}) => {
  const plain = { loaded: false, loading: false, children: [], error: null, sourceEntryCount: 0 }
  const state = reactiveState ? reactive(plain) : plain
  const loaded = []
  const lists = []
  const listing = createDirectoryListing({ state, getLocation: () => location, cloudStatus,
    list: async (path) => { lists.push(path); return { ok: true, entries: (entries[path] || []).map((entry) => ({ ...entry })) } },
    onLoaded: (payload) => loaded.push(payload), ...options })
  return { listing, state, loaded, lists, location }
}

test('rows are listed before cloud status, then statuses arrive in batches on the same objects', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'one.txt'), file('/a', 'two.txt'), file('/a', 'three.txt'), { name: 'dir', path: '/a/dir', isDirectory: true }] }
  const h = harness({ entries, cloudStatus: status })
  assert.equal(await h.listing.load(), true)
  const children = h.state.children
  const objects = [...children]
  assert.equal(children.length, 4)
  assert.equal(children.some((entry) => entry.contentAvailability), false, 'listing carries no cloud status')
  await settle()
  const [scan] = status.scans
  assert.deepEqual(scan.paths, ['/a/one.txt', '/a/two.txt', '/a/three.txt'], 'folders are not inspected')
  for (const path of scan.paths) assert.equal(h.listing.statusOf(path), 'pending')

  scan.onBatch(['/a/one.txt', '/a/two.txt'], { ok: true, statuses: [{ path: '/a/one.txt', contentAvailability: cloud }, { path: '/a/two.txt' }] })
  assert.deepEqual(children[0].contentAvailability, cloud)
  assert.equal('contentAvailability' in children[1], false)
  assert.equal(h.listing.statusOf('/a/two.txt'), 'resolved', 'an empty status is a final result')
  assert.equal(h.listing.statusOf('/a/three.txt'), 'pending')
  scan.onBatch(['/a/three.txt'], { ok: true, statuses: [{ path: '/a/three.txt', contentAvailability: { state: 'materializing', progress: 0.5 } }] })
  scan.finished.resolve()
  await settle()

  assert.equal(h.state.children, children, 'the children array is never replaced by status updates')
  assert.deepEqual(h.state.children, objects)
  objects.forEach((entry, index) => assert.equal(h.state.children[index], entry))
  assert.equal(h.loaded.length, 1, 'statuses never repeat children-loaded')
  assert.equal(h.lists.length, 1, 'statuses never reload the folder')
  assert.equal(status.scans.length, 1, 'a resolved folder is not inspected again')
  h.listing.dispose()
})

test('status updates touch only the affected row, not the displayed list', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'b.txt'), file('/a', 'a.txt'), file('/a', 'c.txt')] }
  const h = harness({ entries, cloudStatus: status, reactiveState: true })
  let listRuns = 0
  const displayed = computed(() => { listRuns++; return sortAndFilterEntries(h.state.children, { sort: 'name' }, 0) })
  const badgeRuns = new Map()
  const badges = () => displayed.value.map((entry) => computed(() => {
    badgeRuns.set(entry.path, (badgeRuns.get(entry.path) || 0) + 1)
    return getFileStatusBadge(entry)
  }))
  await h.listing.load()
  const rows = displayed.value
  const rowBadges = badges()
  rowBadges.forEach((badge) => badge.value)
  const listRunsBefore = listRuns
  await settle()
  status.scans[0].onBatch(['/a/b.txt'], { ok: true, statuses: [{ path: '/a/b.txt', contentAvailability: cloud }] })
  assert.equal(displayed.value, rows, 'sorting/filtering is not recomputed')
  assert.equal(listRuns, listRunsBefore)
  assert.deepEqual(rowBadges.map((badge) => badge.value?.icon ?? null), [null, 'mdi-cloud-download-outline', null])
  assert.deepEqual(Object.fromEntries(badgeRuns), { '/a/a.txt': 1, '/a/b.txt': 2, '/a/c.txt': 1 })
  h.listing.dispose()
})

test('results for a folder that was left, refreshed, collapsed or disposed are discarded', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'x.txt')], '/b': [file('/b', 'x.txt')] }
  const h = harness({ entries, cloudStatus: status })
  await h.listing.load(); await settle()
  const scanA = status.scans[0]
  h.location.path = '/b'
  await h.listing.load(); await settle()
  assert.equal(scanA.signal.aborted, true, 'opening another folder aborts the old scan')
  scanA.onBatch(['/a/x.txt'], { ok: true, statuses: [{ path: '/a/x.txt', contentAvailability: cloud }] })
  assert.equal(h.state.children[0].path, '/b/x.txt')
  assert.equal(h.state.children[0].contentAvailability, undefined, 'A results never change B')

  const scanB = status.scans[1]
  h.listing.invalidate() // collapse
  assert.equal(scanB.signal.aborted, true)
  scanB.onBatch(['/b/x.txt'], { ok: true, statuses: [{ path: '/b/x.txt', contentAvailability: cloud }] })
  assert.equal(h.state.children[0].contentAvailability, undefined)

  await h.listing.load({ force: true }); await settle()
  const scanC = status.scans[2]
  h.listing.dispose()
  assert.equal(scanC.signal.aborted, true)
  scanC.onBatch(['/b/x.txt'], { ok: true, statuses: [{ path: '/b/x.txt', contentAvailability: cloud }] })
  assert.equal(h.state.children[0].contentAvailability, undefined)
})

test('rapid refreshes keep only the newest scan and unchanged badges do not blink', async () => {
  const status = scriptedStatus()
  const listed = [file('/a', 'kept.txt'), file('/a', 'edited.txt')]
  const h = harness({ entries: { '/a': listed }, cloudStatus: status })
  await h.listing.load(); await settle()
  status.scans[0].onBatch(['/a/kept.txt', '/a/edited.txt'], { ok: true, statuses: [
    { path: '/a/kept.txt', contentAvailability: cloud }, { path: '/a/edited.txt', contentAvailability: cloud }] })
  listed[1] = file('/a', 'edited.txt', { modifiedAt: '2026-10-10T01:00:00.000Z', size: 2 })
  await Promise.all([h.listing.load({ force: true }), h.listing.load({ force: true }), h.listing.load({ force: true })])
  await settle()
  assert.equal(h.lists.length, 4)
  assert.equal(status.scans.length, 2, 'superseded refreshes never start a scan')
  assert.equal(status.scans[0].signal.aborted, true)
  const [kept, edited] = h.state.children
  assert.deepEqual(kept.contentAvailability, cloud, 'an unchanged entry keeps its status while re-inspected')
  assert.equal(edited.contentAvailability, undefined, 'a changed entry starts without a stale status')
  assert.equal(h.listing.statusOf('/a/kept.txt'), 'pending')
  status.scans[1].onBatch(['/a/kept.txt', '/a/edited.txt'], { ok: true, statuses: [{ path: '/a/kept.txt' }, { path: '/a/edited.txt' }] })
  assert.equal(kept.contentAvailability, undefined, 'the fresh result replaces the provisional one')
  h.listing.dispose()
})

test('a replaced file, a failed entry and a failed batch are never retried in the same listing', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'replaced.txt'), file('/a', 'broken.txt'), file('/a', 'later.txt')] }
  const h = harness({ entries, cloudStatus: status })
  await h.listing.load(); await settle()
  const scan = status.scans[0]
  scan.onBatch(['/a/replaced.txt', '/a/broken.txt'], { ok: true, statuses: [
    { path: '/a/replaced.txt', modifiedAt: '2026-10-11T00:00:00.000Z', contentAvailability: cloud },
    { path: '/a/broken.txt', error: { code: 'ENOENT' } }] })
  scan.onBatch(['/a/later.txt'], { ok: false, error: { code: 'ETIMEDOUT' } })
  scan.finished.resolve(); await settle()
  assert.equal(h.state.children[0].contentAvailability, undefined, 'metadata of a newer file is not applied')
  assert.equal(h.listing.statusOf('/a/replaced.txt'), 'resolved')
  assert.equal(h.listing.statusOf('/a/broken.txt'), 'failed')
  assert.equal(h.listing.statusOf('/a/later.txt'), 'failed')
  assert.equal(h.state.error, null, 'status failures never fail the folder')
  assert.equal(status.scans.length, 1)
  h.listing.dispose()
})

test('the same folder in two panels gets independent statuses', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'shared.txt')] }
  const left = harness({ entries, cloudStatus: status, consumer: 'left' })
  const right = harness({ entries, cloudStatus: status, consumer: 'right' })
  await Promise.all([left.listing.load(), right.listing.load()]); await settle()
  assert.equal(status.scans.length, 2)
  assert.notEqual(left.state.children[0], right.state.children[0])
  status.scans[1].onBatch(['/a/shared.txt'], { ok: true, statuses: [{ path: '/a/shared.txt', contentAvailability: cloud }] })
  assert.deepEqual(right.state.children[0].contentAvailability, cloud)
  assert.equal(left.state.children[0].contentAvailability, undefined)
  right.listing.dispose()
  assert.equal(status.scans[0].signal.aborted, false, 'closing one panel keeps the other scan')
  left.listing.dispose()
})

test('remote providers and runtimes without cloud status never inspect', async () => {
  const status = scriptedStatus({ supported: false })
  const h = harness({ entries: { '/a': [file('/a', 'x.txt')] }, cloudStatus: status, location: { providerId: 'sftp:host', path: '/a' } })
  await h.listing.load(); await settle()
  assert.equal(status.scans.length, 0)
  assert.equal(h.listing.statusOf('/a/x.txt'), 'resolved')
  assert.equal(await appCloudStatus.supports({ providerId: 'local' }), false, 'browser/SEA has no native cloud status')
  assert.equal(DEFAULT_CAPABILITIES.cloudStatus, false)
  assert.equal(normalizeCapabilities({ cloudStatus: true }).cloudStatus, true)
  assert.equal(normalizeCapabilities({}).cloudStatus, false)
  h.listing.dispose()
})

test('statuses are requested in displayed order first, then the rest', async () => {
  const status = scriptedStatus()
  const entries = { '/a': [file('/a', 'a.txt'), file('/a', 'b.txt'), file('/a', 'hidden.log')] }
  let h
  h = harness({ entries, cloudStatus: status,
    statusOrder: () => [...h.state.children].filter((entry) => entry.name.endsWith('.txt')).reverse() })
  await h.listing.load(); await settle()
  assert.deepEqual(status.scans[0].paths, ['/a/b.txt', '/a/a.txt', '/a/hidden.log'])
  h.listing.dispose()
})

test('applyCloudStatus removes cleared fields and keeps equal values untouched', () => {
  const entry = reactive({ name: 'x', contentAvailability: { state: 'cloud' }, cloudSync: { state: 'inSync' } })
  const previous = entry.contentAvailability
  applyCloudStatus(entry, { contentAvailability: { state: 'cloud' } })
  assert.equal(entry.contentAvailability, previous)
  assert.equal('cloudSync' in entry, false)
})

test('the inspector sends small batches, limits concurrency, stops on abort and honors complete', async () => {
  const requests = []
  const pending = []
  const request = (event, payload, options) => {
    requests.push({ event, payload, options })
    if (event !== 'filesystem:cloud-status') return Promise.resolve({ ok: true })
    const reply = deferred()
    pending.push({ payload, reply })
    return reply.promise
  }
  let id = 0
  const inspector = createCloudStatusInspector({ request, batchSize: 2, concurrency: 2, pause: () => Promise.resolve(), newId: () => `r${++id}` })
  const scan = (paths, signal, batches) => inspector.inspect({ providerId: 'local', path: '/a', paths, signal,
    onBatch: (batch, response) => batches.push([batch, response]) })
  const first = new AbortController(); const second = new AbortController(); const third = new AbortController()
  const batches = [[], [], []]
  const runs = [scan(['/a/1', '/a/2', '/a/3'], first.signal, batches[0]), scan(['/a/4'], second.signal, batches[1]), scan(['/a/5'], third.signal, batches[2])]
  await settle()
  assert.equal(pending.length, 2, 'at most two batches are in flight across folders')
  assert.deepEqual(pending[0].payload.paths, ['/a/1', '/a/2'])
  third.abort()
  pending[1].reply.resolve({ ok: true, statuses: [] })
  await settle()
  assert.equal(pending.length, 2, 'an aborted waiter never reaches the backend')
  first.abort()
  assert.ok(requests.some(({ event, payload }) => event === 'filesystem:cloud-status-cancel' && payload.requestId === 'r1'))
  pending[0].reply.resolve({ ok: false, error: { code: 'ECANCELLED' } })
  await Promise.all(runs)
  assert.equal(batches[0].length, 0, 'an aborted scan reports nothing more')
  assert.equal(batches[1].length, 1)
  assert.equal(requests.filter(({ event }) => event === 'filesystem:cloud-status').length, 2)

  pending.length = 0
  const completeBatches = []
  const run = scan(['/b/1', '/b/2', '/b/3', '/b/4', '/b/5'], new AbortController().signal, completeBatches)
  await settle()
  pending[0].reply.resolve({ ok: true, statuses: [], complete: true })
  await run
  assert.equal(pending.length, 1, 'a folder without cloud provider needs one request')
  assert.deepEqual(completeBatches.map(([paths]) => paths), [['/b/1', '/b/2'], ['/b/3', '/b/4', '/b/5']])
})

test('the limiter hands slots over without exceeding its bound', async () => {
  const limit = createLimiter(1)
  let active = 0; let peak = 0
  const task = async () => { active++; peak = Math.max(peak, active); await settle(); active-- ; return true }
  const results = await Promise.all([limit(task), limit(task), limit(task)])
  assert.deepEqual(results, [true, true, true])
  assert.equal(peak, 1)
})

test('a window without animation frames still proceeds to the next batch', async () => {
  const { afterPaint } = await import('../src/api/cloudStatus.js')
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0 // hidden or occluded window
  try {
    const started = Date.now()
    await afterPaint()
    assert.ok(Date.now() - started < 2000)
  } finally {
    if (original) globalThis.requestAnimationFrame = original
    else delete globalThis.requestAnimationFrame
  }
})
