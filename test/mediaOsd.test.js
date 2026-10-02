import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { createMediaOsd, formatMediaOsd } from '../src/player/mediaOsd.js'

const event = (kind, extra = {}) => ({ id: kind, kind, currentTime: 475, duration: 7163, createdAt: 1000, ...extra })
test('Play Pause and confirmed Resume use shared media duration formatter', () => {
  for (const kind of ['play', 'pause', 'resume']) assert.deepEqual(formatMediaOsd(event(kind)), {
    title: kind === 'resume' ? 'Play' : kind[0].toUpperCase() + kind.slice(1), detail: '7:55 / 1:59:23',
  })
  assert.equal(formatMediaOsd(null), null)
})
test('audio subtitles and Off use the same track formatter as menus', () => {
  assert.deepEqual(formatMediaOsd(event('audio', { track: { kind: 'audio', id: 1, language: 'eng', title: 'Commentary', friendlyCodec: 'DTS-HD MA', channelLayout: 'undefined8' } })), { title: 'Audio', detail: 'English · Commentary · DTS-HD MA · 7.1' })
  assert.deepEqual(formatMediaOsd(event('subtitle', { track: { id: 1, kind: 'subtitle', language: 'rus', codec: 'ASS' } })), { title: 'Subtitles', detail: 'Russian · ASS' })
  assert.deepEqual(formatMediaOsd(event('subtitle')), { title: 'Subtitles', detail: 'Off' })
})
test('replacement restarts timer, stale callbacks cannot hide newest event, reset disposes', () => {
  let current = null
  const timers = []
  const cancelled = []
  let now = 1000
  const osd = createMediaOsd({ now: () => now, onChange: (v) => { current = v }, setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length }, clearTimer: (id) => cancelled.push(id) })
  osd.accept(event('pause')); assert.equal(current.title, 'Pause'); assert.equal(timers[0].delay, 1800)
  now += 300
  osd.accept(event('audio', { createdAt: now })); assert.equal(current.title, 'Audio'); assert.equal(timers[1].delay, 1800)
  timers[0].fn(); assert.equal(current.title, 'Audio')
  osd.accept(event('audio')); assert.equal(timers.length, 2)
  assert.ok(cancelled.includes(1))
  osd.reset(); assert.equal(current, null); timers[1].fn(); assert.equal(current, null)
  osd.accept(event('resume', { createdAt: now })); assert.equal(current.title, 'Play'); osd.dispose(); assert.equal(current, null)
})
test('initial autoplay has no event and late attachment never replays expired OSD', () => {
  const changes = []
  const osd = createMediaOsd({ now: () => 20000, onChange: (v) => changes.push(v) })
  osd.accept(null); osd.accept(event('resume')); assert.deepEqual(changes, [])
  osd.dispose()
})
test('OSD remains independent of controls visibility and honors reduced motion', async () => {
  const component = await fs.readFile(new URL('../src/components/MediaOsd.vue', import.meta.url), 'utf8')
  assert.match(component, /pointer-events: none/)
  assert.match(component, /prefers-reduced-motion: reduce/)
  const overlay = await fs.readFile(new URL('../src/media-overlay/MediaOverlay.vue', import.meta.url), 'utf8')
  assert.match(overlay, /<MediaOsd :message="osdMessage"/)
})

test('confirmed restore is visible for a full interval when native overlay attaches late', () => {
  let current; let delay
  const osd = createMediaOsd({ now: () => 4000, onChange: (value) => { current = value }, setTimer: (_, ms) => { delay = ms } })
  osd.accept(event('resume')); assert.deepEqual(current, { title: 'Play', detail: '7:55 / 1:59:23' }); assert.equal(delay, 1800)
  osd.dispose()
})
