import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
  WebMediaPlayerBackend,
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
      return { ok: true, state: { status: PlayerStatus.READY } }
    },
  }
  const player = new NativeMpvPlayerBackend({ autoplay: true, transport })
  const geometry = { x: 1, y: 2, width: 640, height: 360, scaleFactor: 2 }

  await player.setSource({ providerId: 'sftp:demo', path: '/video/one.mkv' }, geometry)
  await player.setSource({ providerId: 'local', path: '/video/two.mp4' }, geometry)
  stateListener({
    status: PlayerStatus.PLAYING,
    currentTime: 4,
    duration: 90,
    tracks: [{ id: 1, kind: 'audio' }],
    diagnostics: { sourceHdr: true, sourceFormat: 'HDR10 / PQ', outputHdrActive: true },
  })

  assert.deepEqual(requests.slice(0, 2), [
    {
      eventName: 'player:open',
      payload: {
        filesystemId: 'sftp:demo',
        path: '/video/one.mkv',
        autoplay: true,
        geometry,
      },
    },
    {
      eventName: 'player:open',
      payload: {
        filesystemId: 'local',
        path: '/video/two.mp4',
        autoplay: true,
        geometry,
      },
    },
  ])
  assert.equal(player.snapshot().source, 'local:/video/two.mp4')
  assert.equal(player.snapshot().currentTime, 4)
  assert.equal(player.snapshot().tracks[0].kind, 'audio')
  assert.equal(player.snapshot().diagnostics.outputHdrActive, true)

  player.close()
  await Promise.resolve()
  assert.equal(unsubscribed, true)
  assert.equal(requests.at(-1).eventName, 'player:close')
  assert.equal(player.snapshot().status, PlayerStatus.CLOSED)
})
