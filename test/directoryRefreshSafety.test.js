import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { createDirectoryListing } from '../src/utils/directoryListing.js'
import { createDirectoryWatchRegistry } from '../src/api/directoryWatch.js'
import { reconcileDirectorySelection } from '../src/utils/reconcileDirectorySelection.js'
import { getContentAvailabilityBadge } from '../src/utils/contentAvailability.js'
import { createContentPreparer } from '../src/api/content.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const entries = ['a.mp3', 'b.txt'].map(name => ({ name, path: `/home/${name}`, providerId: 'local', isDirectory: false }))
const success = (value = entries) => ({ ok: true, entries: value })
const fixture = (options = {}) => {
  const state = { loaded: false, children: [], error: null, loading: false, sourceEntryCount: 0 }
  const location = { providerId: 'local', path: '/home' }
  const applied = []
  const listing = createDirectoryListing({ state, getLocation: () => location,
    list: async () => success(), onLoaded: x => applied.push(x), ...options })
  return { ...listing, state, location, applied }
}

test('watch refresh replaces cloud and materializing entries and removes the ready badge', async () => {
  let event
  const registry = createDirectoryWatchRegistry({
    request: async () => ({ ok: true }),
    subscribe: (_name, callback) => { event = callback; return () => {} },
  }, 1)
  let availability = { state: 'cloud' }
  const h = fixture({ list: async () => success([{ ...entries[0], contentAvailability: availability }]) })
  await h.load()
  const original = h.state.children[0]
  assert.equal(getContentAvailabilityBadge(original).icon, 'mdi-cloud-download-outline')
  const stop = registry.subscribe('local', '/home', () => h.load({ force: true }))
  for (const next of [{ state: 'materializing', progress: 0.42 }, undefined]) {
    availability = next
    const previous = h.state.children[0]
    event({ providerId: 'local', directoryPath: '/home', kind: 'changed' })
    for (let i = 0; i < 100 && h.state.children[0] === previous; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.notEqual(h.state.children[0], previous)
    assert.equal(getContentAvailabilityBadge(h.state.children[0])?.icon ?? null,
      next ? 'mdi-cloud-sync-outline' : null)
  }
  // A stale object still says cloud, but the rendered/current listing uses its replacement.
  assert.equal(original.contentAvailability.state, 'cloud')
  stop(); h.dispose()
})

test('completed materialization invalidates a stale badge even without a final OS event', async () => {
  const registry = createDirectoryWatchRegistry({ request: async () => ({ ok: true }), subscribe: () => () => {} }, 1)
  let availability = { state: 'materializing' }
  const h = fixture({ list: async () => success([{ ...entries[0], contentAvailability: availability }]) })
  await h.load()
  const stop = registry.subscribe('local', '/home', () => h.load({ force: true }))
  const prepare = createContentPreparer({ poll: async () => {}, onMaterialized: registry.refreshFile,
    request: async (event) => {
      if (event === 'content:prepare') return { ok: true, preparation: { state: 'MATERIALIZING', operationId: 'download' } }
      availability = undefined
      return { ok: true, preparation: { state: 'READY' } }
    },
  })
  assert.equal((await prepare(entries[0])).ok, true)
  for (let i = 0; i < 100 && h.state.children[0].contentAvailability; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(getContentAvailabilityBadge(h.state.children[0]), null)
  stop(); h.dispose()
})

test('superseded empty response cannot replace a newer successful listing or selection', async () => {
  const old = deferred(); let calls = 0
  const h = fixture({ list: () => ++calls === 2 ? old.promise : Promise.resolve(success()) })
  await h.load(); const waiting = h.load({ force: true }); await h.load({ force: true })
  old.resolve(success([])); await waiting
  assert.deepEqual(h.state.children, entries); assert.equal(h.applied.length, 2)
  assert.equal(h.state.loading, false); h.dispose()
})
test('failed refresh and transport exception retain successful contents and do not mark a new folder empty', async () => {
  for (const failure of [() => Promise.resolve({ ok: false, error: { message: 'Offline' } }), () => { throw Error('Lost transport') }]) {
    let calls = 0; const h = fixture({ list: () => ++calls === 1 ? success() : failure() })
    await h.load(); await h.load({ force: true })
    assert.deepEqual(h.state.children, entries); assert.equal(h.state.loaded, true)
    assert.ok(h.state.error); assert.equal(h.state.loading, false); h.dispose()
  }
  const initial = fixture({ list: async () => ({ ok: false, error: { message: 'Denied' } }) })
  await initial.load(); assert.equal(initial.state.loaded, false); initial.dispose()
})
test('provider, directory, collapse and unmount invalidate old listings', async () => {
  for (const change of ['path', 'provider', 'collapse', 'unmount']) {
    const d = deferred(); let active = true
    const h = fixture({ list: () => d.promise, isActive: () => active })
    const pending = h.load()
    if (change === 'path') h.location.path = '/elsewhere'
    if (change === 'provider') h.location.providerId = 'sftp:new'
    if (change === 'collapse') { active = false; h.invalidate() }
    if (change === 'unmount') h.dispose()
    d.resolve(success([])); await pending
    assert.equal(h.applied.length, 0, change); assert.equal(h.state.loaded, false, change)
    h.dispose()
  }
})
test('only a successful current response can make a directory empty; filtered emptiness retains raw count', async () => {
  const h = fixture({ list: async () => ({ ...success([]), sourceEntryCount: 5 }) })
  await h.load(); assert.equal(h.state.loaded, true); assert.equal(h.state.children.length, 0)
  assert.equal(h.state.sourceEntryCount, 5); h.dispose()
  const source = await fs.readFile(new URL('../src/components/FileTreeNode.vue', import.meta.url), 'utf8')
  assert.match(source, /No items match the current filters/)
  assert.match(source, /v-if="expanded && displayedChildren.length"/)
  assert.match(source, /listing\.dispose\(\)/)
})
test('two shared-watch panels survive materialization bursts and delayed stale empty responses independently', async () => {
  let event; const requests = []
  const registry = createDirectoryWatchRegistry({ request: async (name, payload) => {
    requests.push({ name, payload }); return { ok: true }
  }, subscribe: (_name, fn) => { event = fn; return () => {} } }, 1)
  const panels = ['left', 'right'].map(consumer => {
    let calls = 0; const old = deferred()
    let selected = entries[0]
    const h = fixture({ consumer, list: async (path, options) => {
      assert.equal(path, '/home'); assert.equal(options.providerId, 'local')
      return ++calls === 2 ? old.promise : success()
    }, onLoaded: ({ path, entries: next, previous }) => {
      const selection = reconcileDirectorySelection({ selectedEntries: [selected], selectedNode: selected,
        anchorPath: selected.path, rootPath: '/home', root: { path: '/home' } }, path, next, 'local')
      selected = selection.selectedNode
    } })
    return { ...h, old, calls: () => calls, selected: () => selected }
  })
  await Promise.all(panels.map(p => p.load()))
  const stops = panels.map(p => registry.subscribe('local', '/home', () => p.load({ force: true })))
  const settle = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 2))
    assert.equal(predicate(), true)
  }
  for (let i = 0; i < 30; i++) event({ providerId: 'local', directoryPath: '/home', kind: 'changed' })
  await settle(() => panels.every(p => p.calls() === 2))
  for (let i = 0; i < 20; i++) event({ providerId: 'local', directoryPath: '/home', kind: 'changed' })
  await settle(() => panels.every(p => p.calls() === 3 && !p.state.loading))
  for (const p of panels) p.old.resolve(success([]))
  await new Promise(r => setTimeout(r, 2))
  for (const p of panels) {
    assert.deepEqual(p.location, { providerId: 'local', path: '/home' })
    assert.deepEqual(p.state.children, entries); assert.equal(p.selected().path, '/home/a.mp3')
    assert.equal(p.state.loaded, true); assert.equal(p.state.error, null); p.dispose()
  }
  assert.equal(requests.filter(r => r.name === 'filesystem:watch').length, 1)
  stops[0](); assert.equal(registry.count(), 1); stops[1](); assert.equal(registry.count(), 0)
})
