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

test('quantizes positions and bounds memory with LRU eviction and source/size keys', async () => {
  const calls = []
  const service = createThumbnailService({ maxEntries: 2, generate: async (args) => { calls.push(args); return ready(args.time) } })
  const request = (time, extra) => service.getThumbnail({ path: '/one.mp4', time, width: 180, ...extra })
  await request(1.1)
  await request(1.4)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].time, 1)
  await request(2)
  await request(1.2) // touch first
  await request(3) // evicts second
  await request(2)
  assert.equal(calls.length, 4)
  await request(2, { width: 240 })
  await request(2, { path: '/two.mp4' })
  assert.equal(calls.length, 6)
  service.clearCache()
  await request(2, { path: '/two.mp4' })
  assert.equal(calls.length, 7)
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
  assert.deepEqual(calls, [{ path: args.path, time: 30, width: 180 }])
  assert.deepEqual(await service.getThumbnail(args), first)
  assert.equal(calls.length, 1)
  assert.equal((await service.getThumbnail({ ...args, providerId: 'ssh:test' })).thumbnail.reason, 'remote')
  assert.equal(calls.length, 1)
})
