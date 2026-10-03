import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
  WebMediaPlayerBackend,
  setNativeTransitionCover,
} from '../src/player/mediaPlayerBackend.js'

class FakeMediaElement extends EventTarget {
  constructor() {
    super()
    this.src = ''
    this.currentTime = 0
    this.duration = Number.NaN
    this.volume = 1
    this.muted = false
    this.paused = true
    this.loadCount = 0
    this.pauseCount = 0
  }

  load() {
    this.loadCount += 1
    this.dispatchEvent(new Event('loadstart'))
  }

  async play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }

  pause() {
    this.paused = true
    this.pauseCount += 1
    this.dispatchEvent(new Event('pause'))
  }

  removeAttribute(name) {
    if (name === 'src') this.src = ''
  }
}

test('web player backend keeps a common playback state', async () => {
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element, { autoplay: true })

  await player.setSource('/api/content?path=movie.mp4')
  assert.equal(player.snapshot().source, '/api/content?path=movie.mp4')
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)

  element.duration = 120
  element.dispatchEvent(new Event('loadedmetadata'))
  player.seek(91)
  element.dispatchEvent(new Event('timeupdate'))
  player.setVolume(0.4)
  element.dispatchEvent(new Event('volumechange'))
  assert.equal(player.snapshot().duration, 120)
  assert.equal(player.snapshot().currentTime, 91)
  assert.equal(player.snapshot().volume, 0.4)

  player.pause()
  assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
  player.close()
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
  assert.equal(element.src, '')
})

test('finished web video rewinds and waits for Play before replaying', async () => {
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element)
  await player.setSource('short.mp4')
  element.duration = 8
  await player.play()
  element.currentTime = 8
  element.dispatchEvent(new Event('ended'))
  assert.equal(element.currentTime, 0)
  assert.equal(element.paused, true)
  assert.equal(player.snapshot().currentTime, 0)
  assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
  await player.play()
  assert.equal(element.paused, false)
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
  assert.equal(element.loadCount, 1)
  player.close()
})

test('source switching stops the previous source without leaking listeners', async () => {
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element)

  await player.setSource('first.mp4')
  await player.setSource('second.mkv')
  assert.equal(element.pauseCount, 2)
  assert.equal(element.loadCount, 2)
  assert.equal(player.snapshot().source, 'second.mkv')

  player.close()
  element.dispatchEvent(new Event('play'))
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
})

test('native player routes provider sources and releases the active player', async () => {
  const requests = []
  let stateListener = null
  let unsubscribed = false
  const transport = {
    subscribe(eventName, listener) {
      assert.equal(eventName, 'player:state')
      stateListener = listener
      return () => { unsubscribed = true }
    },
    async request(eventName, payload = {}) {
      requests.push({ eventName, payload })
      return { ok: true, sessionId: payload.sessionId, state: { status: PlayerStatus.READY } }
    },
  }
  const player = new NativeMpvPlayerBackend({ autoplay: true, transport })
  const geometry = { x: 1, y: 2, width: 640, height: 360, scaleFactor: 2 }

  await player.setSource({ providerId: 'sftp:demo', path: '/video/one.mkv' }, geometry)
  const firstSessionId = player.sessionId
  await player.setSource({ providerId: 'local', path: '/video/two.mp4' }, geometry)
  const secondSessionId = player.sessionId
  stateListener({
    sessionId: secondSessionId,
    status: PlayerStatus.PLAYING,
    currentTime: 4,
    duration: 90,
    tracks: [{ id: 1, kind: 'audio' }],
    diagnostics: { sourceHdr: true, sourceFormat: 'HDR10 / PQ', outputHdrActive: true },
  })

  assert.notEqual(firstSessionId, secondSessionId)
  assert.deepEqual(requests.map(({ eventName }) => eventName), [
    'player:open',
    'player:close',
    'player:open',
  ])
  assert.deepEqual(requests[0].payload, {
    sessionId: firstSessionId,
    filesystemId: 'sftp:demo',
    path: '/video/one.mkv',
    autoplay: true,
    geometry,
  })
  assert.deepEqual(requests[1].payload, { sessionId: firstSessionId })
  assert.deepEqual(requests[2].payload, {
    sessionId: secondSessionId,
    filesystemId: 'local',
    path: '/video/two.mp4',
    autoplay: true,
    geometry,
  })
  assert.equal(player.snapshot().source, 'local:/video/two.mp4')
  assert.equal(player.snapshot().currentTime, 4)
  assert.equal(player.snapshot().tracks[0].kind, 'audio')
  assert.equal(player.snapshot().diagnostics.outputHdrActive, true)

  player.close()
  await Promise.resolve()
  assert.equal(unsubscribed, true)
  assert.equal(requests.at(-1).eventName, 'player:close')
  assert.equal(requests.at(-1).payload.sessionId, secondSessionId)
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
})

test('native lifecycle opens and closes ten distinct sessions without stale state', async () => {
  const requests = []
  let stateListener = null
  const transport = {
    subscribe(_eventName, listener) {
      stateListener = listener
      return () => {}
    },
    async request(eventName, payload = {}) {
      requests.push({ eventName, payload })
      if (eventName === 'player:open') {
        return { ok: true, sessionId: payload.sessionId, state: { status: PlayerStatus.READY } }
      }
      return { ok: true, sessionId: payload.sessionId, state: { status: PlayerStatus.PAUSED } }
    },
  }
  const geometry = { x: 0, y: 0, width: 320, height: 180, scaleFactor: 1 }

  for (let index = 0; index < 10; index += 1) {
    const player = new NativeMpvPlayerBackend({ transport })
    await player.setSource({ providerId: 'local', path: `/tiny-${index}.mp4` }, geometry)
    const sessionId = player.sessionId
    stateListener({ sessionId: `stale-${index}`, status: PlayerStatus.ERROR, error: 'stale' })
    assert.equal(player.snapshot().status, PlayerStatus.READY)
    await player.play()
    await player.pause()
    await player.seek(1)
    player.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests.at(-1).eventName, 'player:close')
    assert.equal(requests.at(-1).payload.sessionId, sessionId)
  }

  assert.equal(requests.filter(({ eventName }) => eventName === 'player:open').length, 10)
  assert.equal(requests.filter(({ eventName }) => eventName === 'player:close').length, 10)
})

test('native playback commands are not sent while the session is opening', async () => {
  const requests = []
  let finishOpen
  const transport = {
    subscribe() { return () => {} },
    request(eventName, payload = {}) {
      requests.push({ eventName, payload })
      if (eventName === 'player:open') {
        return new Promise((resolve) => { finishOpen = resolve })
      }
      return Promise.resolve({ ok: true, sessionId: payload.sessionId })
    },
  }
  const player = new NativeMpvPlayerBackend({ transport })
  const opening = player.setSource(
    { providerId: 'local', path: '/tiny.mp4' },
    { x: 0, y: 0, width: 320, height: 180, scaleFactor: 1 },
  )

  const skipped = await player.play()
  assert.equal(skipped.skipped, true)
  assert.deepEqual(requests.map(({ eventName }) => eventName), ['player:open'])

  finishOpen({ ok: true, sessionId: player.sessionId, state: { status: PlayerStatus.READY } })
  await opening
  await player.play()
  assert.deepEqual(requests.map(({ eventName }) => eventName), ['player:open', 'player:play'])
  player.close()
})

test('recoverable layout errors never poison playback state or block pause', async () => {
  const requests = []
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe() { return () => {} },
    async request(eventName, payload) {
      requests.push(eventName)
      if (eventName === 'player:open') return { ok: true, sessionId: payload.sessionId,
        state: { status: PlayerStatus.PLAYING } }
      if (eventName === 'player:set-overlay') return { ok: false,
        error: { code: 'EMPV_OVERLAY', message: 'Overlay resize failed' } }
      return { ok: true, state: { status: PlayerStatus.PAUSED } }
    },
  } })
  await player.setSource({ providerId: 'local', path: '/test.mp4' }, {})
  await assert.rejects(player.setOverlay(true, {}), /Overlay resize failed/)
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
  assert.equal(player.snapshot().error, null)
  await player.pause()
  assert.equal(requests.at(-1), 'player:pause')
  assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
  player.dispose()
})

test('outside the desktop runtime the fullscreen transition falls back to the WebView cover', async () => {
  assert.equal(await setNativeTransitionCover(true, 150), false)
  assert.equal(await setNativeTransitionCover(false, 180), false)
})

test('close during native opening ignores the late ready response', async () => {
  let finishOpen
  let openedSession
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe() { return () => {} },
    async request(event, payload) {
      if (event === 'player:open') {
        openedSession = payload.sessionId
        return new Promise((resolve) => { finishOpen = resolve })
      }
      return { ok: true }
    },
  } })
  const opening = player.setSource({ path: '/video.mp4' }, {})
  player.close()
  await new Promise((resolve) => setImmediate(resolve))
  finishOpen({ ok: true, sessionId: openedSession, state: { status: PlayerStatus.READY } })
  await opening
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
  assert.equal(player.hasOpenedSession, false)
  assert.equal(player.sessionId, null)
})

test('source switch cancels pending native opening and ignores its late error', async () => {
  const requests = []
  let finishFirst
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe() { return () => {} },
    request(eventName, payload) {
      requests.push({ eventName, payload })
      if (eventName === 'player:open' && payload.path === '/first.mp4') {
        return new Promise((resolve) => { finishFirst = resolve })
      }
      return Promise.resolve({ ok: true, sessionId: payload.sessionId,
        state: { status: PlayerStatus.READY } })
    },
  } })
  const first = player.setSource({ path: '/first.mp4' }, {})
  const firstSession = player.sessionId
  await player.setSource({ path: '/second.mp4' }, {})
  assert.deepEqual(requests.map(({ eventName }) => eventName), ['player:open', 'player:close', 'player:open'])
  assert.equal(requests[1].payload.sessionId, firstSession)
  assert.notEqual(player.sessionId, firstSession)
  finishFirst({ ok: false, error: { message: 'Opening cancelled' } })
  await first
  assert.equal(player.snapshot().source, 'local:/second.mp4')
  assert.equal(player.snapshot().status, PlayerStatus.READY)
  assert.equal(player.snapshot().error, null)
  player.close()
})

test('closing during a pending native open ignores a late transport rejection', async () => {
  let rejectOpen
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe() { return () => {} },
    request(eventName) {
      if (eventName === 'player:open') return new Promise((_, reject) => { rejectOpen = reject })
      return Promise.resolve({ ok: true })
    },
  } })
  const opening = player.setSource({ path: '/video.mp4' }, {})
  player.close()
  rejectOpen(new Error('Native command cancelled'))
  await opening
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
  assert.equal(player.snapshot().error, null)
})

test('rapid source switches while close is pending open only the latest source', async () => {
  const paths = []
  const finishClose = []
  let stateListener
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe(_eventName, listener) { stateListener = listener; return () => {} },
    request(eventName, payload) {
      if (eventName === 'player:close') return new Promise((resolve) => { finishClose.push(resolve) })
      paths.push(payload.path)
      return Promise.resolve({ ok: true, sessionId: payload.sessionId,
        state: { status: PlayerStatus.READY } })
    },
  } })
  await player.setSource({ path: '/first.mp4' }, {})
  const second = player.setSource({ path: '/second.mp4' }, {})
  const third = player.setSource({ path: '/third.mp4' }, {})
  stateListener({ sessionId: player.sessionId, status: PlayerStatus.ERROR, error: 'Cancelled old VO' })
  assert.equal(player.snapshot().status, PlayerStatus.CLOSING)
  assert.equal(player.snapshot().error, null)
  finishClose.forEach((resolve) => resolve({ ok: true }))
  await Promise.all([second, third])
  assert.deepEqual(paths, ['/first.mp4', '/third.mp4'])
  assert.equal(player.snapshot().source, 'local:/third.mp4')
  player.dispose()
})

test('close while switching source cannot open the replacement after teardown', async () => {
  let finishClose
  let opens = 0
  const player = new NativeMpvPlayerBackend({ transport: {
    subscribe() { return () => {} },
    request(event, payload) {
      if (event === 'player:open') {
        opens += 1
        return Promise.resolve({ ok: true, sessionId: payload.sessionId,
          state: { status: PlayerStatus.READY } })
      }
      return new Promise((resolve) => { finishClose = resolve })
    },
  } })
  await player.setSource({ path: '/first.mp4' }, {})
  const switching = player.setSource({ path: '/second.mp4' }, {})
  const finishSourceClose = finishClose
  player.close()
  finishClose({ ok: true })
  await new Promise((resolve) => setImmediate(resolve))
  finishSourceClose({ ok: true })
  await switching
  await player.setSource({ path: '/third.mp4' }, {})
  assert.equal(opens, 1)
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
  assert.equal(player.sessionId, null)
})

test('web resume waits for metadata and confirmed seek before autoplay and Resume OSD', async () => {
  const requests = []
  const history = { request: async (_, payload) => { requests.push(payload); return { ok: true, position: 475 } } }
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element, { autoplay: true, history })
  await player.setSource('movie', { path: '/movie.mkv', providerId: 'local' })
  assert.equal(element.paused, true)
  assert.equal(player.snapshot().osd, null)
  element.duration = 7200
  element.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(element.currentTime, 475)
  assert.equal(element.paused, true)
  assert.equal(player.snapshot().osd, null)
  element.dispatchEvent(new Event('seeked'))
  assert.equal(element.paused, false)
  assert.equal(player.snapshot().osd.kind, 'resume')
  assert.equal(player.snapshot().osd.currentTime, 475)
  player.pause()
  assert.equal(player.snapshot().osd.kind, 'pause')
  assert.ok(requests.some((p) => p.event === 'pause' && p.position === 475))
  await player.play()
  assert.equal(player.snapshot().osd.kind, 'play')
  player.close()
  assert.ok(requests.some((p) => p.event === 'close' && p.position === 475))
})

test('web first open, beginning and EOF skip Resume; ticks mirror RAM and EOF saves before rewind', async () => {
  for (const position of [null, 5, 598]) {
    const requests = []
    const history = { request: async (_, p) => { requests.push(p); return { ok: true, position } } }
    const element = new FakeMediaElement()
    const player = new WebMediaPlayerBackend(element, { autoplay: true, history })
    await player.setSource('movie', { path: '/movie' })
    element.duration = 600
    element.dispatchEvent(new Event('loadedmetadata'))
    assert.equal(element.currentTime, 0)
    assert.equal(player.snapshot().osd, null)
    element.currentTime = 475
    element.dispatchEvent(new Event('timeupdate'))
    element.dispatchEvent(new Event('timeupdate'))
    assert.equal(requests.filter((p) => p.event === 'tick').length, 1)
    element.currentTime = 600
    element.dispatchEvent(new Event('ended'))
    assert.ok(requests.some((p) => p.event === 'eof' && p.position === 600))
    assert.equal(element.currentTime, 0)
    player.close()
  }
})

test('web source switch saves old position and cancelled lookup cannot revive a closed session', async () => {
  const requests = []
  const history = { request: async (_, p) => { requests.push(p); return { ok: true, position: null } } }
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element, { history })
  await player.setSource('one', { path: '/one' })
  element.duration = 600
  element.dispatchEvent(new Event('loadedmetadata'))
  const id = player.historySession
  element.currentTime = 100
  await player.setSource('two', { path: '/two' })
  assert.ok(requests.some((p) => p.event === 'close' && p.sessionId === id && p.position === 100))
  assert.notEqual(player.historySession, id)
  player.close()
  let finish
  const late = new WebMediaPlayerBackend(new FakeMediaElement(), { history: { request: (_, p) => p.event === 'open' ? new Promise((r) => { finish = r }) : Promise.resolve({ ok: true }) } })
  const opening = late.setSource('late', { path: '/late' })
  await new Promise((r) => setImmediate(r))
  late.close()
  finish({ ok: true, position: 100 })
  await opening
  assert.equal(late.snapshot().status, PlayerStatus.CLOSED)
  assert.equal(late.element.src, '')
})


test('native pending seek stays at clicked target through stale snapshots and replacement failures', async () => {
  let listener; const replies = []
  const transport = { subscribe: (_, cb) => { listener = cb; return () => {} }, request: (name) => name === 'player:seek' ? new Promise((resolve) => replies.push(resolve)) : Promise.resolve({ ok: true }) }
  const player = new NativeMpvPlayerBackend({ sessionId: 'seek-test', transport })
  player.update({ status: PlayerStatus.PLAYING, currentTime: 100, duration: 7200 })
  const first = player.seek(475)
  listener({ sessionId: 'seek-test', currentTime: 100, seeking: true })
  assert.equal(player.snapshot().pendingSeekTime, 475)
  const second = player.seek(3000)
  replies[0]({ ok: false, error: { message: 'Seek superseded' } })
  await assert.rejects(first, /superseded/)
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
  assert.equal(player.snapshot().pendingSeekTime, 3000)
  listener({ sessionId: 'seek-test', currentTime: 475, seeking: false })
  assert.equal(player.snapshot().pendingSeekTime, 3000)
  replies[1]({ ok: true, state: { currentTime: 3000, seeking: false } }); await second
  assert.equal(player.snapshot().pendingSeekTime, null)
  assert.equal(player.snapshot().currentTime, 3000)
  player.dispose()
})

const chapterFixture = [
  { index: 0, title: 'Вступление 日本語', startTime: 0 },
  { index: 1, title: '  ', startTime: 25.25 },
  { index: 2, title: 'Fin — café', startTime: 80.5 },
]
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('web/audio chapters use provider metadata, Unicode, exact selection and boundaries', async () => {
  const element = new FakeMediaElement()
  const locations = []
  const player = new WebMediaPlayerBackend(element, { chapterMetadata: async (location) => {
    locations.push(location); return { ok: true, chapters: chapterFixture }
  } })
  await player.setSource('book', { providerId: 'sftp:book', path: '/book.m4b' })
  await settle()
  element.duration = 120
  element.dispatchEvent(new Event('loadedmetadata'))
  assert.deepEqual(locations, [{ providerId: 'sftp:book', path: '/book.m4b' }])
  assert.equal(player.snapshot().chapters[0].title, 'Вступление 日本語')
  assert.equal(player.snapshot().chapters[1].title, 'Chapter 2')
  assert.equal(player.snapshot().currentChapterIndex, 0)
  player.previousChapter()
  assert.equal(element.currentTime, 0)
  player.nextChapter()
  assert.equal(element.currentTime, 25.25)
  element.dispatchEvent(new Event('seeked'))
  assert.equal(player.snapshot().currentChapterIndex, 1)
  element.currentTime = 80.49
  element.dispatchEvent(new Event('timeupdate'))
  assert.equal(player.snapshot().currentChapterIndex, 1)
  element.currentTime = 80.5
  element.dispatchEvent(new Event('timeupdate'))
  assert.equal(player.snapshot().currentChapterIndex, 2)
  player.nextChapter()
  assert.equal(element.currentTime, 80.5)
  player.previousChapter()
  assert.equal(element.currentTime, 25.25)
  player.selectChapter(2)
  assert.equal(element.currentTime, 80.5)
  player.selectChapter(99)
  assert.equal(element.currentTime, 80.5)
  player.close()
  assert.deepEqual(player.snapshot().chapters, [])
})

test('chapter metadata failures, no chapters and stale source/close replies cannot break playback', async () => {
  let resolveOld
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element, { autoplay: true, chapterMetadata: (location) => {
    if (location.path === 'old') return new Promise((resolve) => { resolveOld = resolve })
    if (location.path === 'failure') throw new Error('Unsupported metadata')
    return Promise.resolve({ ok: true, chapters: [] })
  } })
  await player.setSource('old', { path: 'old' })
  await player.setSource('new', { path: 'new' })
  resolveOld({ ok: true, chapters: chapterFixture })
  await settle()
  assert.deepEqual(player.snapshot().chapters, [])
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
  await player.setSource('failure', { path: 'failure' })
  await settle()
  assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
  assert.deepEqual(player.snapshot().chapters, [])
  await player.setSource('old-again', { path: 'old' })
  player.close()
  resolveOld({ ok: true, chapters: chapterFixture })
  await settle()
  assert.deepEqual(player.snapshot().chapters, [])
})

test('M4B web resume keeps an absolute position inside its chapter and uses media:history', async () => {
  const requests = []
  const history = { request: async (event, payload) => {
    assert.equal(event, 'media:history'); requests.push(payload)
    return { ok: true, position: 47.375 }
  } }
  const element = new FakeMediaElement()
  const player = new WebMediaPlayerBackend(element, { history, autoplay: true,
    chapterMetadata: async () => ({ ok: true, chapters: chapterFixture }) })
  await player.setSource('book', { providerId: 'local', path: '/book.m4b' })
  await settle()
  element.duration = 120
  element.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(element.currentTime, 47.375)
  assert.equal(element.paused, true)
  element.dispatchEvent(new Event('seeked'))
  assert.equal(player.snapshot().currentChapterIndex, 1)
  assert.equal(player.snapshot().currentChapter.startTime, 25.25)
  assert.equal(player.snapshot().currentTime, 47.375)
  player.pause()
  assert.ok(requests.some((p) => p.event === 'pause' && p.position === 47.375))
  player.close()
  assert.ok(requests.some((p) => p.event === 'close' && p.position === 47.375))
})

test('native chapters use the existing absolute seek and preserve file navigation', async () => {
  const requests = []
  let receive
  const player = new NativeMpvPlayerBackend({ sessionId: 'chapters', transport: {
    subscribe: (_event, listener) => { receive = listener; return () => {} },
    request: async (event, payload) => {
      requests.push({ event, payload })
      return { ok: true, state: { currentTime: payload.seconds, seeking: false } }
    },
  } })
  receive({ sessionId: 'chapters', status: PlayerStatus.PAUSED, duration: 120,
    currentTime: 47.375, chapters: chapterFixture })
  assert.equal(player.snapshot().currentChapterIndex, 1)
  await player.nextChapter()
  assert.equal(requests.at(-1).payload.seconds, 80.5)
  assert.equal(player.snapshot().currentChapterIndex, 2)
  await player.nextChapter()
  assert.equal(requests.length, 1)
  await player.previousChapter()
  await player.selectChapter(0)
  await player.previousChapter()
  assert.equal(requests.length, 3)
  assert.ok(requests.every(({ event }) => event === 'player:seek'))
  player.dispose()
})
