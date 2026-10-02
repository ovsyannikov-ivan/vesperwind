import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { compileTemplate } from '@vue/compiler-sfc'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createThumbnailPreview, loadThumbnailImage } from '../src/player/thumbnailPreview.js'
import { createThumbnailService } from '../src/api/thumbnailService.js'

const ready = (url = 'data:image/jpeg;base64,ready') => ({ thumbnail: { status: 'ready', url } })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const harness = (extra = {}) => {
  let now = 0; let id = 0
  const timers = new Map(); const calls = []
  const controller = createThumbnailPreview({
    getSource: () => ({ path: '/movie.mkv', providerId: 'local' }),
    request: async (args) => { calls.push(args); return ready() },
    loadImage: async (url) => url,
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, due: now + ms }); return key },
    clearTimer: (key) => timers.delete(key), ...extra,
  })
  return { ...controller, calls, timers,
    advance(ms) {
      now += ms
      for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); void timer.fn() }
    },
  }
}

test('pointer flood updates time immediately but starts no extraction until 250 ms stillness', async () => {
  const h = harness()
  for (let i = 0; i < 60; i++) { h.show(i, i / 100); h.advance(20) }
  assert.equal(h.preview.time, 59)
  assert.equal(h.preview.visible, true)
  assert.equal(h.preview.url, '')
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.size, 1)
  h.advance(229); assert.equal(h.calls.length, 0)
  h.advance(1); await flush()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].time, 59)
  assert.equal(h.preview.url, ready().thumbnail.url)
  h.advance(10000); assert.equal(h.calls.length, 1)
  h.dispose()
})

test('new movement before dwell expires discards the previous timer, including within a bucket', async () => {
  const h = harness()
  h.show(30.1, .3); h.advance(249); h.show(30.2, .3)
  h.advance(249); assert.equal(h.calls.length, 0)
  h.advance(1); await flush()
  assert.deepEqual(h.calls.map((c) => c.time), [30.2])
  h.dispose()
})

test('movement hides a ready image immediately and stale extraction cannot reach image loading', async () => {
  const first = deferred(); const calls = []; const loaded = []
  const h = harness({ request: (args) => { calls.push(args); return calls.length === 1 ? first.promise : Promise.resolve(ready('new')) },
    loadImage: async (url) => { loaded.push(url); return url } })
  h.show(10, .1); h.advance(250)
  h.show(20, .2)
  assert.equal(calls[0].signal.aborted, true)
  first.resolve(ready('old')); await flush()
  assert.equal(h.preview.url, ''); assert.deepEqual(loaded, [])
  h.advance(250); await flush(); assert.equal(h.preview.url, 'new')
  h.show(21, .21); assert.equal(h.preview.url, ''); assert.equal(h.preview.time, 21)
  h.dispose()
})

test('only timestamp is visible until complete image decoding, including a cache hit', async () => {
  const image = deferred(); let loads = 0
  const h = harness({ loadImage: () => { loads++; return image.promise } })
  h.show(1, .1); h.advance(250); await flush()
  assert.equal(loads, 1); assert.equal(h.preview.url, ''); assert.equal(h.preview.loading, false)
  image.resolve(ready().thumbnail.url); await flush()
  assert.equal(h.preview.url, ready().thumbnail.url)
  h.dispose()
})

test('movement during image decode prevents late decoded image from appearing', async () => {
  const image = deferred()
  const h = harness({ loadImage: () => image.promise })
  h.show(1, .1); h.advance(250); await flush()
  h.show(2, .2); image.resolve('old'); await flush()
  assert.equal(h.preview.url, ''); assert.equal(h.preview.time, 2)
  h.dispose()
})

test('leave, source reset and unmount clear dwell, active state, and late results', async () => {
  for (const operation of ['hide', 'reset', 'dispose']) {
    const response = deferred(); let cleared = 0; const calls = []
    const h = harness({ request: (args) => { calls.push(args); return response.promise }, clearCache: () => cleared++ })
    h.show(1, .1); h[operation](); h.advance(1000); assert.equal(calls.length, 0)
    if (operation !== 'dispose') {
      h.show(2, .2); h.advance(250); h[operation]()
      assert.equal(calls[0].signal.aborted, true)
      response.resolve(ready('late')); await flush()
    }
    assert.equal(h.preview.visible, false); assert.equal(h.preview.url, ''); assert.equal(h.timers.size, 0)
    if (operation !== 'hide') assert.ok(cleared >= 1)
    if (operation === 'dispose') { h.show(3, .3); assert.equal(h.timers.size, 0) }
    h.dispose()
  }
  const response = deferred(); let signal
  const h = harness({ request: (args) => { signal = args.signal; return response.promise } })
  h.show(1, .1); h.advance(250); h.dispose(); response.resolve(ready('late')); await flush()
  assert.equal(signal.aborted, true); assert.equal(h.preview.url, ''); assert.equal(h.preview.visible, false)
})

test('remote source remains time-only and image failure remains time-only', async () => {
  const h = harness({ getSource: () => ({ path: '/remote/movie', providerId: 'ssh:test' }) })
  h.show(42, .4); h.advance(10000); assert.equal(h.preview.time, 42); assert.equal(h.calls.length, 0)
  h.dispose()
  const failure = harness({ loadImage: async () => { throw new Error('bad JPEG') } })
  failure.show(1, .1); failure.advance(250); await flush(); assert.equal(failure.preview.url, '')
  failure.dispose()
})

test('LRU hit still waits dwell and hides the prior frame, with no extra extraction', async () => {
  let calls = 0
  const service = createThumbnailService({ generate: async () => { calls++; return ready() } })
  const h = harness({ request: service.getThumbnail, clearCache: service.clearCache })
  h.show(12.1, .1); h.advance(250); await flush(); assert.equal(calls, 1); assert.ok(h.preview.url)
  h.show(12.2, .1); assert.equal(h.preview.url, '')
  h.advance(249); await flush(); assert.equal(h.preview.url, '')
  h.advance(1); await flush(); assert.ok(h.preview.url); assert.equal(calls, 1)
  h.dispose()
})

test('production template has no image container until ready and fades only filled image', async () => {
  const file = await fs.readFile(new URL('../src/components/ThumbnailPreview.vue', import.meta.url), 'utf8')
  const template = file.match(/<template>([\s\S]*?)<\/template>/)[1]
  const { code, errors } = compileTemplate({ source: template, filename: 'ThumbnailPreview.vue', id: 'thumbnail-test' })
  assert.deepEqual(errors, [])
  const module = await import(`data:text/javascript;base64,${Buffer.from(code.replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve('vue'))}`)).toString('base64')}`)
  const render = (preview) => renderToString(createSSRApp({ props: ['preview'], render: module.render,
    setup: () => ({ formatMediaDuration: (n) => String(n) }) }, { preview }))
  const pending = await render({ visible: true, time: 42, ratio: .5, url: '', loading: true })
  assert.match(pending, />42<\/span>/)
  assert.doesNotMatch(pending, /<img|placeholder|spinner|image-outline/)
  const filled = await render({ visible: true, time: 42, ratio: .5, url: 'data:image/jpeg;base64,ready', loading: false })
  assert.match(filled, /<img[^>]+src="data:image\/jpeg;base64,ready"/)
  assert.doesNotMatch(filled, /placeholder|spinner|image-outline/)
  assert.match(file, /thumbnail-image-enter-active\s*\{ transition: opacity 180ms/)
  assert.doesNotMatch(file, /thumbnail-image-leave-active/)
  assert.match(file, /@leave="\(_element, done\) => done\(\)"/)
})

test('actual image loader awaits decode and cancels a detached image on abort', async () => {
  const previous = globalThis.Image; const images = []
  globalThis.Image = class { constructor() { images.push(this); this.naturalWidth = 180 } }
  try {
    const decoding = deferred(); const controller = new AbortController()
    let complete = false
    const loaded = loadThumbnailImage('ready', controller.signal).then(() => { complete = true })
    images[0].decode = () => decoding.promise
    void images[0].onload(); await flush(); assert.equal(complete, false)
    decoding.resolve(); await loaded; assert.equal(complete, true)
    const cancelled = new AbortController()
    const promise = loadThumbnailImage('cancel-me', cancelled.signal)
    cancelled.abort(); await assert.rejects(promise, /cancelled/)
    assert.equal(images[1].src, '')
  } finally { globalThis.Image = previous }
})
