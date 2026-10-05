import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { ref } from 'vue'
import { mediaHistoryEnabled, isAudiobook } from '../src/player/mediaHistoryPolicy.js'
import { useMediaViewer } from '../src/composables/useMediaViewer.js'
import { useQuickLook } from '../src/composables/useQuickLook.js'
import { NativeMpvPlayerBackend } from '../src/player/mediaPlayerBackend.js'

const book = { sourceType: 'provider', providerId: 'local', path: '/book.m4b', kind: 'audio' }
const music = { ...book, path: '/music.mp3' }

test('one policy separates video, persistent audiobooks, temporary audio and URL/live sources', () => {
  assert.equal(mediaHistoryEnabled(book), true)
  assert.equal(mediaHistoryEnabled(music), false)
  for (const source of [book, music]) assert.equal(mediaHistoryEnabled(source, { temporary: true }), false)
  assert.equal(isAudiobook({ ...music, tags: { GENRE: 'Audiobook' } }), true)
  assert.equal(isAudiobook({ ...music, tags: { genre: 'Аудиокнига' } }), true)
  assert.equal(isAudiobook({ ...music, chapters: [{ title: 'Track 1' }] }), false)
  assert.equal(mediaHistoryEnabled({ ...book, sourceType: 'url', url: 'https://example.com/book.m4b' }), false)
  assert.equal(mediaHistoryEnabled({ ...book, live: true }), false)
})

test('Space, View and double click pass identical video history to the shared native player', async () => {
  for (const gesture of ['Space', 'View', 'doubleclick']) {
    const audio = { current: ref(null), open() {}, hide() {} }
    const viewer = useMediaViewer({ audio, prepareMedia: async () => ({ ok: true, source: 'prepared' }) })
    const context = { node: { name: 'movie.mp4', path: '/movie.mp4' }, filesystemId: 'local' }
    const quick = useQuickLook({ openMedia: viewer.openMedia, closeMedia: viewer.closeViewer })
    if (gesture === 'Space') await quick.open(context)
    else viewer.openMedia(context)
    const descriptor = viewer.currentViewerMedia.value
    assert.equal(descriptor.historyEnabled, true, gesture)
    const calls = []
    const player = new NativeMpvPlayerBackend({ kind: 'video', historyEnabled: descriptor.historyEnabled,
      transport: { subscribe: () => () => {}, request: async (event, payload) => {
        calls.push({ event, payload }); return { ok: true, sessionId: payload.sessionId }
      } } })
    await player.setSource(descriptor, { x: 0, y: 0, width: 100, height: 100, scaleFactor: 1 })
    assert.equal(calls[0].payload.historyEnabled, true, gesture)
    await player.close(); quick.close(); viewer.closeViewer()
  }
})

test('actual toolbar and temporary audio bind the separate history policies', async () => {
  const bar = await fs.readFile(new URL('../src/components/AudioPlayerBar.vue', import.meta.url), 'utf8')
  const quick = await fs.readFile(new URL('../src/components/QuickLookModal.vue', import.meta.url), 'utf8')
  assert.match(bar, /:history-enabled="mediaHistoryEnabled\(media, \{ kind: 'audio' \}\)"/)
  assert.match(quick, /kind="audio"[\s\S]*:history-enabled="false"/)
})
