import assert from 'node:assert/strict'
import test from 'node:test'
import { createThumbnailService } from '../src/api/thumbnailService.js'
const ready = (id) => ({ ok: true, thumbnail: { status: 'ready', url: `data:image/jpeg;base64,${id}` } })
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('remote, invalid and cancelled requests never start extraction', async () => {
  let calls = 0
  const service = createThumbnailService({ generate: async () => { calls++; return ready('one') } })
  const args = { path: '/one.mp4', time: 10, width: 180 }
  for (const extra of [{ providerId: 'ssh:one' }, { time: NaN }, { time: -1 }, { signal: AbortSignal.abort() }]) {
    const result = await service.getThumbnail({ ...args, ...extra })
    assert.equal(result.thumbnail.status, 'unavailable')
  }
  assert.equal(calls, 0)
})

test('half-second buckets reuse bounded hover cache', async () => {
  const calls = []
  const service = createThumbnailService({ generate: async (args) => { calls.push(args); return ready(args.time) } })
  const args = { path: '/one.mp4', time: 153.7 }
  await service.getThumbnail(args)
  await service.getThumbnail(args)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].time, 153.5)
  assert.equal(calls[0].providerId, 'local')
})

test('a mouse flood keeps one running extraction and only the latest pending position', async () => {
  const calls = []
  const completions = []
  const service = createThumbnailService({ generate: (args) => {
    calls.push(args.time)
    return new Promise((resolve) => completions.push(resolve))
  } })
  const request = (time) => service.getThumbnail({ path: '/one.mp4', time })
  const first = request(1)
  const discarded = []
  for (let i = 2; i < 40; i++) discarded.push(request(i))
  const last = request(40)
  assert.deepEqual(calls, [1])
  for (const result of await Promise.all(discarded)) assert.equal(result.thumbnail.reason, 'superseded')
  completions[0](ready('first'))
  await first
  await tick()
  assert.deepEqual(calls, [1, 40])
  completions[1](ready('last'))
  assert.equal((await last).thumbnail.url, ready('last').thumbnail.url)
})

test('stale active responses are ignored, aborted pending jobs are skipped and failures release the queue', async () => {
  let finish
  const service = createThumbnailService({ generate: () => new Promise((resolve) => { finish = resolve }) })
  const active = new AbortController()
  const next = new AbortController()
  const first = service.getThumbnail({ path: '/one.mp4', time: 1, signal: active.signal })
  const pending = service.getThumbnail({ path: '/one.mp4', time: 2, signal: next.signal })
  active.abort()
  next.abort()
  finish(ready('old'))
  assert.equal((await first).thumbnail.reason, 'cancelled')
  assert.equal((await pending).thumbnail.reason, 'cancelled')
  const failing = createThumbnailService({ generate: async () => { throw new Error('missing binary') } })
  assert.equal((await failing.getThumbnail({ path: '/one.mp4', time: 1 })).thumbnail.reason, 'failed')
  assert.equal((await failing.getThumbnail({ path: '/one.mp4', time: 2 })).thumbnail.reason, 'failed')
})

test('oversized thumbnails are returned but never cached', async () => {
  let calls = 0
  const service = createThumbnailService({ maxBytes: 10, generate: async () => { calls++; return ready('large') } })
  await service.getThumbnail({ path: '/one.mp4', time: 1 })
  await service.getThumbnail({ path: '/one.mp4', time: 1 })
  assert.equal(calls, 2)
})


test('HDR sources reach the extractor and share the SDR thumbnail cache contract', async () => {
  const calls = []
  const service = createThumbnailService({ generate: async (args) => { calls.push(args); return ready('tonemapped') } })
  const args = { path: '/HDR10-BT2020.mkv', time: 30, width: 180, sourceHdr: true }
  const first = await service.getThumbnail(args)
  assert.equal(first.thumbnail.status, 'ready')
  assert.equal(first.thumbnail.url, ready('tonemapped').thumbnail.url)
  const { requestId, ...call } = calls[0]
  assert.ok(requestId)
  assert.deepEqual(call, { path: args.path, time: 30, width: 180, providerId: 'local' })
  assert.deepEqual(await service.getThumbnail(args), first)
  assert.equal(calls.length, 1)
  assert.equal((await service.getThumbnail({ ...args, providerId: 'ssh:test' })).thumbnail.reason, 'remote')
  assert.equal(calls.length, 1)
})

test('LRU refreshes hits, evicts old frames and clearing cancels active work without repopulating cache', async () => {
  const calls = []; let finish; const cancelled = []
  const service = createThumbnailService({ maxEntries: 2, generate: async (args) => { calls.push(args.time); return ready(args.time) } })
  const request = (time) => service.getThumbnail({ path: '/movie', time })
  await request(1); await request(2); await request(1); await request(3); await request(1); await request(2)
  assert.deepEqual(calls, [1, 2, 3, 2])
  const active = createThumbnailService({ generate: () => new Promise((resolve) => { finish = resolve }), cancel: (id) => cancelled.push(id) })
  const first = active.getThumbnail({ path: '/movie', time: 1 })
  const pending = active.getThumbnail({ path: '/movie', time: 2 })
  active.clearCache(); await tick()
  assert.equal(cancelled.length, 1)
  assert.equal((await pending).thumbnail.reason, 'cancelled')
  finish(ready('stale')); assert.equal((await first).thumbnail.reason, 'cancelled')
  const again = active.getThumbnail({ path: '/movie', time: 1 })
  finish(ready('fresh')); assert.equal((await again).thumbnail.url, ready('fresh').thumbnail.url)
})

test('abort requests native cancellation once and stale completion is neither displayed nor cached', async () => {
  const signals = []; const cancelled = []; const finishes = []
  const service = createThumbnailService({ generate: (args) => { signals.push(args.requestId); return new Promise((resolve) => finishes.push(resolve)) }, cancel: (id) => cancelled.push(id) })
  const controller = new AbortController()
  const first = service.getThumbnail({ path: '/movie', time: 1, signal: controller.signal })
  controller.abort(); await tick()
  assert.deepEqual(cancelled, [signals[0]])
  finishes[0](ready('old')); assert.equal((await first).thumbnail.reason, 'cancelled')
  const second = service.getThumbnail({ path: '/movie', time: 1 })
  assert.equal(signals.length, 2)
  finishes[1](ready('new')); assert.equal((await second).thumbnail.url, ready('new').thumbnail.url)
})
