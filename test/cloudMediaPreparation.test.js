import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick } from 'vue'
import { createContentPreparer } from '../src/api/content.js'
import { createMediaPreparation } from '../src/api/media.js'
import { useAudioPlayer } from '../src/composables/useAudioPlayer.js'
import { useQuickLook } from '../src/composables/useQuickLook.js'
const file = (name = 'song.mp3') => ({ name, path: `/${name}`, sourceType: 'provider', providerId: 'local', kind: 'audio' })
const ready = () => ({ ok: true, preparation: { state: 'READY', progress: 1 } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await nextTick() }

test('native playback waits through materialization and never requests a browser source', async () => {
  const poll = deferred(), calls = []
  const prepareContent = createContentPreparer({ poll: () => poll.promise, request: async (event) => {
    calls.push(event)
    if (event === 'content:prepare') return { ok: true, preparation: { state: 'MATERIALIZING', operationId: 'download', progress: .2 } }
    return ready()
  } })
  const preparation = createMediaPreparation({ prepareContent, getPreparedSource: () => { throw Error('Native needs no URL') } })
  let complete = false; const states = []
  const result = preparation.prepare(file(), { native: true, onStatus: s => states.push(s.state) }).then(r => { complete = true; return r })
  await flush(); assert.equal(complete, false); assert.deepEqual(states, ['MATERIALIZING'])
  poll.resolve(); assert.equal((await result).source, 'native-audio')
  assert.deepEqual(states, ['MATERIALIZING', 'READY']); assert.ok(calls.includes('content:cancel'))
})
test('cancellation during initial native preparation cancels a late operation and publishes no READY', async () => {
  const first = deferred(), calls = [], controller = new AbortController()
  const prepare = createContentPreparer({ request: (event) => {
    calls.push(event); return event === 'content:prepare' ? first.promise : Promise.resolve({ ok: true })
  } })
  const result = prepare(file(), { signal: controller.signal, onStatus: () => { throw Error('Stale status') } })
  controller.abort(); first.resolve({ ok: true, preparation: { state: 'MATERIALIZING', operationId: 'late' } })
  assert.equal((await result).error.code, 'ECONTENT_CANCELLED'); assert.deepEqual(calls, ['content:prepare', 'content:cancel'])
})
test('failed download remains an error and cannot become a playable native source', async () => {
  const p = createMediaPreparation({ prepareContent: async () => ({ ok: false, error: { code: 'ECLOUD_OFFLINE', message: 'Offline' } }) })
  assert.equal((await p.prepare(file(), { native: true })).error.code, 'ECLOUD_OFFLINE')
  const invalid = createMediaPreparation({ prepareContent: async () => ({ ok: true, preparation: { state: 'MATERIALIZING' } }) })
  assert.equal((await invalid.prepare(file(), { native: true })).error.code, 'ECONTENT_NOT_READY')
})
test('persistent native audio keeps the queue, invalidates a downloading track and recovers on the next track', async () => {
  const downloads = [], scope = effectScope()
  const audio = scope.run(() => useAudioPlayer({ storage: null, metadata: null, chooseBackend: async () => 'mpv',
    prepareSource: (item, options) => { const d = deferred(); downloads.push({ ...d, item, options }); return d.promise } }))
  audio.open(file()); await flush()
  assert.equal(audio.current.value.loading, true); assert.equal(audio.current.value.preparedSource, '')
  assert.equal(downloads[0].options.native, true)
  downloads[0].options.onStatus({ userMessage: 'Downloading…', progress: .4 })
  assert.equal(audio.current.value.statusMessage, 'Downloading…')
  assert.equal(audio.current.value.preparationProgress, .4)
  audio.open(file('next.mp3')); await flush()
  assert.equal(downloads[0].options.signal.aborted, true); assert.equal(audio.state.items.length, 2)
  downloads[0].resolve({ ok: true, source: 'stale' }); downloads[1].resolve({ ok: false, error: { message: 'Offline' } }); await flush()
  assert.equal(audio.current.value.error.message, 'Offline'); assert.equal(audio.current.value.loading, false)
  audio.open(file('ready.m4b')); await flush(); downloads[2].resolve({ ok: true, source: 'native-audio' }); await flush()
  assert.equal(audio.current.value.path, '/ready.m4b'); assert.equal(audio.current.value.preparedSource, 'native-audio')
  assert.equal(audio.current.value.loading, false); scope.stop()
})
test('closing Quick Look during download invalidates the player and leaves another preview usable', async () => {
  const d = deferred(); let signal
  const q = useQuickLook({ beforePlayback: async () => {}, openMedia() {}, closeMedia() {}, selectBackend: async () => 'mpv',
    prepareMedia: (_location, options) => { signal = options.signal; assert.equal(options.native, true); return d.promise } })
  const opening = q.open({ node: file('book.m4b'), filesystemId: 'local' }); await flush()
  assert.equal(q.preview.value.loading, true); assert.equal(q.preview.value.sourceUrl, '')
  q.close(); assert.equal(signal.aborted, true); d.resolve({ ok: true, source: 'late' }); await opening
  assert.equal(q.preview.value, null)
})

test('cancellation during polling rejects a late READY response and releases the operation', async () => {
  const status = deferred(), controller = new AbortController(), calls = [], states = []
  const prepare = createContentPreparer({ poll: async () => {}, request: (event) => {
    calls.push(event)
    if (event === 'content:prepare') return Promise.resolve({ ok: true, preparation: { state: 'MATERIALIZING', operationId: 'polling' } })
    if (event === 'content:status') return status.promise
    return Promise.resolve({ ok: true })
  } })
  const result = prepare(file(), { signal: controller.signal, onStatus: value => states.push(value.state) })
  await flush(); controller.abort(); status.resolve(ready())
  assert.equal((await result).error.code, 'ECONTENT_CANCELLED')
  assert.deepEqual(states, ['MATERIALIZING'])
  assert.deepEqual(calls, ['content:prepare', 'content:status', 'content:cancel'])
})
test('Quick Look retains downloading progress without publishing a player source', async () => {
  const download = deferred(); let options
  const q = useQuickLook({ beforePlayback: async () => {}, openMedia() {}, closeMedia() {}, selectBackend: async () => 'mpv',
    prepareMedia: (_location, value) => { options = value; return download.promise } })
  const opening = q.open({ node: file(), filesystemId: 'local' }); await flush()
  options.onStatus({ userMessage: 'Preparing file…', progress: .35 })
  assert.equal(q.preview.value.preparationProgress, .35)
  assert.equal(q.preview.value.loading, true); assert.equal(q.preview.value.sourceUrl, '')
  download.resolve({ ok: true, source: 'native-audio' }); await opening
  assert.equal(q.preview.value.loading, false); assert.equal(q.preview.value.sourceUrl, 'native-audio')
  q.close()
})
