import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createAudioPlaylist, audioIdentity } from '../src/player/audioPlaylist.js'
import { verticalWorkspaceSizes, MIN_WORKSPACE_HEIGHT } from '../src/player/workspaceSizing.js'
import { createFileDragPayload, parseFileDragPayload } from '../src/utils/fileDrag.js'
import { createPlaybackCoordinator } from '../src/player/playbackCoordination.js'
const node = (name, providerId = 'local', isDirectory = false) => ({ name, providerId, isDirectory, path: `/music/${name}` })
const ids = (queue) => queue.state.items.map((item) => item.id)
const addTracks = (queue) => queue.add(['one.mp3', 'two.m4b', 'three.flac', 'four.ac3'].map((name) => node(name)))
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('empty player, close/reopen and normal open preserve queue and never autoplay visibility changes', () => {
  let stops = 0
  const q = createAudioPlaylist({ onStop: () => stops++ })
  q.toggleVisible()
  assert.equal(q.state.visible, true)
  assert.equal(q.state.currentId, null)
  assert.equal(q.state.autoplay, false)
  q.open(node('one.mp3'))
  assert.equal(q.state.autoplay, true)
  q.open(node('two.m4b'))
  q.open(node('one.mp3'))
  assert.equal(q.state.items.length, 2)
  assert.equal(q.state.currentId, audioIdentity(node('one.mp3')))
  q.hide()
  assert.equal(q.state.visible, false)
  assert.equal(q.state.autoplay, false)
  assert.equal(q.state.items.length, 2)
  q.toggleVisible()
  assert.equal(q.state.autoplay, false)
  assert.equal(stops, 1)
})

test('existing DnD protocol adds local/SFTP multi-selection in source order, filters directories/non-audio/duplicates', () => {
  const q = createAudioPlaylist()
  for (const provider of ['local', 'sftp:home']) {
    const sources = ['one.mp3', 'image.jpg', 'folder.flac', 'two.ec3', 'three.ape'].map((name, index) => node(name, provider, index === 2))
    const payload = parseFileDragPayload(createFileDragPayload(sources[0], 'right', provider, sources))
    q.add(payload.sources)
    q.add(payload.sources)
  }
  assert.deepEqual(q.state.items.map((item) => item.name), ['one.mp3', 'two.ec3', 'three.ape', 'one.mp3', 'two.ec3', 'three.ape'])
  assert.equal(q.state.currentId, null)
  assert.equal(q.state.autoplay, false)
})

test('normal navigation and natural EOF implement repeat off/all/one with independent manual navigation', () => {
  const q = createAudioPlaylist()
  addTracks(q)
  const order = ids(q)
  q.play(order[0])
  assert.equal(q.step(-1), false)
  q.ended(); assert.equal(q.state.currentId, order[1])
  q.cycleRepeat(); assert.equal(q.state.repeat, 'all')
  q.play(order[3]); q.ended(); assert.equal(q.state.currentId, order[0])
  q.step(-1); assert.equal(q.state.currentId, order[3])
  q.cycleRepeat(); assert.equal(q.state.repeat, 'one')
  const revision = q.state.playRevision
  q.ended(); assert.equal(q.state.currentId, order[3]); assert.equal(q.state.playRevision, revision + 1)
  q.step(-1); assert.equal(q.state.currentId, order[2])
  q.cycleRepeat(); assert.equal(q.state.repeat, 'off')
  q.play(order[3]); q.ended(); assert.equal(q.state.currentId, order[3]); assert.equal(q.state.autoplay, false)
})

test('shuffle has a stable complete cycle, previous follows history and repeat-all starts a fresh cycle', () => {
  const q = createAudioPlaylist({ random: () => 0.25 })
  addTracks(q)
  const original = ids(q)
  q.play(original[1]); q.setShuffle(true)
  const cycle = [q.state.currentId, ...q.state.upcoming]
  assert.equal(q.state.currentId, original[1])
  q.step(1); const second = q.state.currentId
  q.step(-1); assert.equal(q.state.currentId, original[1])
  q.step(1); assert.equal(q.state.currentId, second)
  q.step(1); q.step(1)
  assert.equal(q.step(1), false)
  assert.deepEqual(q.state.history, cycle)
  assert.equal(new Set(cycle).size, original.length)
  assert.deepEqual(ids(q), original)
  const last = q.state.currentId
  q.state.repeat = 'all'
  const nextCycle = []
  for (let i = 0; i < original.length; i++) { q.ended(); nextCycle.push(q.state.currentId) }
  assert.notEqual(nextCycle[0], last)
  assert.equal(new Set(nextCycle).size, original.length)
})

test('shuffle addition/removal retains current and a valid order, manual selection records real history', () => {
  const q = createAudioPlaylist({ random: () => 0.5 })
  addTracks(q)
  q.play(ids(q)[0]); q.setShuffle(true)
  q.add([node('five.mka')])
  q.remove([q.state.upcoming[0]])
  assert.equal(q.state.upcoming.length, 3)
  assert.ok(!q.state.upcoming.includes(q.state.currentId))
  const selected = q.state.upcoming[1]
  const previous = q.state.currentId
  q.play(selected); q.step(-1)
  assert.equal(q.state.currentId, previous)
  q.step(1); assert.equal(q.state.currentId, selected)
  assert.ok(!q.state.upcoming.includes(selected))
  assert.ok(q.state.upcoming.every((id) => ids(q).includes(id)))
})

test('remove non-current, remove current and clear stop only when required without autoplay', () => {
  let stops = 0
  const q = createAudioPlaylist({ onStop: () => stops++ })
  addTracks(q); const order = ids(q)
  q.play(order[1]); q.state.selectedId = order[3]
  q.remove([order[3]]); assert.equal(q.state.currentId, order[1]); assert.equal(stops, 0)
  q.state.selectedId = order[1]
  q.remove([order[1]]); assert.equal(q.state.currentId, null); assert.equal(q.state.selectedId, order[2]); assert.equal(q.state.autoplay, false)
  q.clear(); assert.equal(q.state.items.length, 0); assert.equal(q.state.selectedId, null); assert.equal(stops, 2)
})

test('provider-scoped directory rename/move/delete synchronize queue and shuffle history', () => {
  const q = createAudioPlaylist({ random: () => 0 })
  q.add([node('one.mp3'), node('one.mp3', 'sftp:home'), node('two.flac')])
  q.play(ids(q)[1]); q.setShuffle(true)
  const key = q.state.items[1].key
  q.sync({ action: 'rename', providerId: 'sftp:home', sourcePath: '/music', destinationPath: '/books' })
  assert.equal(q.state.items[0].path, '/music/one.mp3')
  assert.equal(q.state.items[1].path, '/books/one.mp3')
  assert.equal(q.state.items[1].key, key)
  assert.equal(q.state.history[0], q.state.currentId)
  q.sync({ action: 'move', providerId: 'sftp:home', destinationProviderId: 'local', sourcePath: '/books/one.mp3', destinationPath: '/new/titled.mp3' })
  assert.equal(q.state.items[1].name, 'titled.mp3')
  assert.equal(q.state.items[1].providerId, 'local')
  q.sync({ action: 'delete', providerId: 'sftp:home', sourcePath: '/new' })
  assert.equal(q.state.items.length, 3)
  q.sync({ action: 'delete', providerId: 'local', sourcePath: '/new' })
  assert.equal(q.state.currentId, null)
  assert.equal(q.state.items.length, 2)
  assert.equal(q.state.autoplay, false)
})

test('500 metadata entries use bounded workers, skip current and ignore removed/renamed/stale responses', async () => {
  let active = 0, maxActive = 0
  const pending = []
  const q = createAudioPlaylist({ concurrency: 2, getMetadata: (location) => new Promise((resolve) => {
    active++; maxActive = Math.max(maxActive, active)
    pending.push({ location, resolve: (metadata) => { active--; resolve(metadata) } })
  }) })
  q.add(Array.from({ length: 500 }, (_, i) => node(`${i}.flac`)))
  q.play(ids(q)[0])
  await tick()
  assert.equal(pending.length, 2)
  assert.ok(pending.every((job) => job.location.path !== '/music/0.flac'))
  const removed = q.state.items[1]
  q.remove([removed.id])
  const renamed = q.state.items[1]
  q.sync({ action: 'rename', sourcePath: renamed.path, destinationPath: '/music/new.flac' })
  pending[0].resolve({ ok: true, duration: 999 }); pending[1].resolve({ ok: true, duration: 888 })
  await tick()
  assert.equal(removed.duration, null); assert.equal(renamed.duration, null)
  assert.equal(maxActive, 2)
  const current = q.state.items[0]
  q.acceptState(current.id, { duration: 120, chapters: [{ index: 0, startTime: 0 }] })
  assert.equal(current.duration, 120); assert.equal(current.chapters.length, 1)
  q.dispose()
  pending.slice(2).forEach((job) => job.resolve({ ok: true, duration: 100 }))
  await tick()
  assert.equal(renamed.duration, null)
})

test('metadata failure never blocks playback and stale probe cannot overwrite current session metadata', async () => {
  let resolve
  const q = createAudioPlaylist({ concurrency: 1, getMetadata: () => new Promise((done) => { resolve = done }) })
  q.add([node('one.flac')]); await tick()
  q.play(ids(q)[0]); q.acceptState(q.state.currentId, { duration: 123, chapters: [] })
  resolve({ ok: true, duration: 999 }); await tick()
  assert.equal(q.state.items[0].duration, 123)
  q.dispose()
  const failed = createAudioPlaylist({ getMetadata: async () => { throw Error('offline') } })
  failed.add([node('one.dts')]); await tick()
  assert.equal(failed.state.items[0].duration, null)
  assert.equal(failed.open(node('one.dts')), true)
  failed.dispose()
})

test('playlist and terminal share one height budget as visibility and window size change', () => {
  for (const height of [400, 500, 720, 1080]) for (const playlistVisible of [false, true]) for (const terminalVisible of [false, true]) {
    const size = verticalWorkspaceSizes({ availableHeight: height, playlistVisible, terminalVisible, playlistHeight: 800, terminalHeight: 800 })
    const separators = (terminalVisible ? 6 : 0) + (playlistVisible ? 6 : 0)
    assert.ok(size.terminal + size.playlist + separators + MIN_WORKSPACE_HEIGHT <= height + 0.001)
    assert.ok(size.terminal >= 0 && size.playlist >= 0)
  }
})

test('foreground video/Quick Look pause queue without hiding/changing current/order, images leave it playing', async () => {
  const q = createAudioPlaylist(); addTracks(q); q.play(ids(q)[1])
  const current = q.state.currentId, order = ids(q)
  const policy = createPlaybackCoordinator({ pauseBackgroundAudio: q.pause })
  await policy.beforePlayback('image'); assert.equal(q.state.autoplay, true)
  for (const kind of ['video', 'audio']) {
    q.state.autoplay = true
    await policy.beforePlayback(kind)
    assert.equal(q.state.autoplay, false); assert.equal(q.state.visible, true)
    assert.equal(q.state.currentId, current); assert.deepEqual(ids(q), order)
  }
})

test('UI contracts put player beside Terminal in both modes and playlist before workspace, reuse splitter/drag/chapter controls', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const toolbar = read('src/components/Toolbar.vue'), manager = read('src/components/FileManager.vue')
  const playlist = read('src/components/AudioPlaylist.vue'), bar = read('src/components/AudioPlayerBar.vue')
  assert.match(toolbar, /Terminal[\s\S]*toggle-audio[\s\S]*Player/)
  assert.match(manager, /v-show="audioVisible"/)
  assert.match(manager, /<AudioPlaylist[\s\S]*@resize="resizePlaylist"[\s\S]*class="files-container"/)
  assert.match(playlist, /FILE_ENTRY_MIME/); assert.match(playlist, /parseFileDragPayload/)
  assert.match(bar, /No track selected/); assert.match(bar, /Previous track/); assert.match(bar, /Next track/)
  assert.match(read('src/components/CustomMediaPlayer.vue'), /Previous|ChapterControls/)
  assert.doesNotMatch(read('src/styles/main.css'), /width: min\(560px, 55vw\)|min-width: 800px/)
  assert.match(read('src/composables/useLayout.js'), /audioPlaylistHeight/)
  assert.doesNotMatch(read('src/composables/useAudioPlayer.js'), /media_history|sqlite/i)
  assert.match(read('src/composables/useAudioPlayer.js'), /playlistRecord\(state\)/)
})

test('native audio formats are recognized conservatively including wma and requested extensions', async () => {
  const { getMediaKind, canPreviewMedia } = await import('../shared/mediaTypes.js')
  for (const extension of ['mp3', 'm4a', 'm4b', 'm4r', 'aac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'caf', 'wma', 'ac3', 'eac3', 'ec3', 'dts', 'mka', 'ape']) {
    assert.equal(getMediaKind(`track.${extension}`), 'audio')
    assert.equal(canPreviewMedia(`track.${extension}`), true)
  }
  for (const extension of ['bin', 'dat', 'zip', 'pdf']) assert.notEqual(getMediaKind(`file.${extension}`), 'audio')
})

test('browser metadata reuses one paused element across queued rows and codec failure remains unknown', async () => {
  const { createWebAudioMetadataProbe } = await import('../src/player/webAudioMetadata.js')
  let created = 0
  class Element extends EventTarget {
    duration = NaN
    autoplay = true
    src = ''
    load() { if (this.src) { this.duration = this.src.includes('bad') ? NaN : 42; queueMicrotask(() => this.dispatchEvent(new Event(this.src.includes('bad') ? 'error' : 'loadedmetadata'))) } }
    removeAttribute() { this.src = '' }
  }
  const metadata = createWebAudioMetadataProbe({ prepare: async (location) => ({ ok: true, source: location.path }), createElement: () => { created++; return new Element() } })
  assert.equal((await metadata.probe({ path: '/one.mp3' })).duration, 42)
  assert.equal((await metadata.probe({ path: '/two.mp3' })).duration, 42)
  assert.equal((await metadata.probe({ path: '/bad.ac3' })).duration, null)
  assert.equal(created, 1)
  metadata.dispose()
})
