import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick } from 'vue'
import { normalizeMediaSource, mediaIdentity, trackTitle, trackLabel, mediaSourceLabel } from '../src/player/mediaSource.js'
import { parseM3u, isHlsManifest, exportM3u, resolvePlaylistPath, playlistParentPath } from '../src/player/m3u.js'
import { createAudioPlaylist } from '../src/player/audioPlaylist.js'
import { playlistRecord, restorePlaylist, PLAYLIST_STORAGE_KEY } from '../src/player/playlistPersistence.js'
import { useAudioPlayer } from '../src/composables/useAudioPlayer.js'
import { importPlaylist } from '../src/player/playlistFiles.js'
import { readPlaylistRowDrop, PLAYLIST_ROW_MIME } from '../src/player/playlistDrag.js'
import { FILE_ENTRY_MIME } from '../src/utils/fileDrag.js'
import { NativeMpvPlayerBackend } from '../src/player/mediaPlayerBackend.js'
import { getFileOpenType } from '../src/utils/fileTypes.js'
import { createSourceOpener } from '../src/player/openMediaSource.js'
const location = { sourceType: 'provider', providerId: 'sftp:music', path: '/Music/list.m3u8' }
const file = (name) => ({ sourceType: 'provider', providerId: location.providerId, path: `/Music/${name}`, name })
const url = { sourceType: 'url', url: ' https://EXAMPLE.com/a/stream?token=secret ' , kind: 'audio' }

test('HTTP identity normalizes safely and labels do not expose credentials or query tokens', () => {
  assert.equal(normalizeMediaSource(url).url, 'https://example.com/a/stream?token=secret')
  assert.notEqual(mediaIdentity(url), mediaIdentity({ ...url, url: 'https://example.com/a/stream?token=other' }))
  assert.equal(mediaSourceLabel({ sourceType: 'url', url: 'https://name:secret@example.com/a?token=secret' }), 'example.com/a')
  for (const scheme of ['file', 'data', 'javascript', 'shell', 'command', 'ftp']) assert.throws(() => normalizeMediaSource({ sourceType: 'url', url: `${scheme}://anything` }))
  assert.equal(mediaIdentity(file('a.flac')), JSON.stringify(['sftp:music', '/Music/a.flac']))
})

test('M3U UTF8 BOM CRLF comments EXTINF Unicode and provider-relative paths', () => {
  const parsed = parseM3u('\uFEFF#EXTM3U\r\n\r\n#unknown\r\n#EXTINF:245,Artist — Время 日本語\r\nAlbum/Время 日本語.flac\r\n/Other/book.m4b\r\nhttps://example.com/audio?token=x\r\nmovie.mp4\r\nnested.m3u8\r\nfile:///private/file.flac\r\n', location)
  assert.equal(parsed.hls, false)
  assert.equal(parsed.skipped, 3)
  assert.deepEqual(parsed.entries[0], { sourceType: 'provider', providerId: 'sftp:music', path: '/Music/Album/Время 日本語.flac', name: 'Время 日本語.flac', kind: 'audio', duration: 245, displayName: 'Artist — Время 日本語' })
  assert.equal(parsed.entries[1].path, '/Other/book.m4b')
  assert.equal(parsed.entries[2].url, 'https://example.com/audio?token=x')
  assert.equal(resolvePlaylistPath('C:\\Music\\list.m3u8', '..\\Album\\日本語.flac'), 'C:\\Album\\日本語.flac')
  assert.equal(playlistParentPath('C:\\song.flac'), 'C:\\')
  assert.equal(playlistParentPath('\\\\host\\share\\song.flac'), '\\\\host\\share\\')
  assert.equal(playlistParentPath('/song.flac'), '/')
  for (const directive of ['#EXT-X-TARGETDURATION:6', '#EXT-X-STREAM-INF:BANDWIDTH=200']) {
    assert.equal(isHlsManifest(`#EXTM3U\n${directive}\nsegment.ts`), true)
    assert.equal(parseM3u(`#EXTM3U\n${directive}\nsegment.ts`, location).entries.length, 0)
  }
  assert.equal(getFileOpenType('list.m3u8', ['m3u8']), 'playlist')
})

test('Extended M3U round trip preserves order Unicode URLs and imported titles without provider secrets', () => {
  const q = createAudioPlaylist()
  q.add([{ ...file('Album/Время 日本語.flac'), displayName: 'Artist — Время 日本語', duration: 245 }, url, file('book.m4b')])
  const original = q.state.items.map(mediaIdentity)
  const text = exportM3u(q.state.items, location)
  assert.match(text, /#EXTINF:245,Artist — Время 日本語\nAlbum\/Время 日本語.flac/)
  assert.match(text, /https:\/\/example.com\/a\/stream\?token=secret/)
  assert.doesNotMatch(text, /sftp:music/)
  q.clear()
  const parsed = parseM3u(text, location)
  q.add(parsed.entries.map((entry) => ({ ...entry, kind: 'audio' })))
  assert.deepEqual(q.state.items.map(mediaIdentity), original)
  assert.equal(q.state.items[0].displayName, 'Artist — Время 日本語')
  assert.throws(() => exportM3u(q.state.items, { ...location, providerId: 'local' }), /another provider/)
  assert.equal(parseM3u(exportM3u([{ ...file('#song.flac'), name: '#song.flac' }], location), location).entries[0].path, '/Music/#song.flac')
  q.dispose()
})

test('import appends, checks missing entries, bounds URL probes, skips video and nested playlists, and never autoplays', async () => {
  const q = createAudioPlaylist(); q.add([file('existing.flac')])
  let active = 0, maximum = 0
  const text = '#EXTM3U\nexisting.flac\nmissing.flac\nnew.flac\nhttps://example.com/audio\nhttps://example.com/video\nhttps://example.com/other\nnested.m3u\n'
  const result = await importPlaylist(location, { audio: q,
    filesystem: { readText: async () => ({ ok: true, content: text }), readDir: async () => ({ ok: true, entries: [file('existing.flac'), file('new.flac')] }) },
    media: { getMetadata: async (source) => { active++; maximum = Math.max(maximum, active); await new Promise((r) => setTimeout(r, 1)); active--; return { ok: true, kind: source.url.endsWith('video') ? 'video' : 'audio' } } },
  })
  assert.equal(result.imported, 3); assert.equal(result.skipped, 3); assert.equal(result.duplicates, 1)
  assert.ok(maximum <= 2); assert.equal(q.state.autoplay, false); assert.equal(q.state.currentId, null)
  assert.equal(q.state.selectedId, q.state.items[1].id); assert.equal(q.state.visible, true)
  q.dispose()
})

test('reorder preserves current selection playback history and updates next/previous and persisted order', () => {
  const q = createAudioPlaylist({ random: () => 0.25 }); q.add(['a.flac', 'b.flac', 'c.flac'].map(file))
  const [a, b, c] = q.state.items.map((item) => item.id)
  q.play(b); q.state.selectedId = a
  assert.equal(q.reorder(c, a), true)
  assert.deepEqual(q.state.items.map((i) => i.id), [c, a, b])
  assert.equal(q.state.currentId, b); assert.equal(q.state.selectedId, a); assert.equal(q.state.playRevision, 1)
  assert.equal(q.target(-1), a)
  q.reorder(c, b, true); assert.equal(q.target(1), c)
  q.setShuffle(true); const history = [...q.state.history], upcoming = [...q.state.upcoming]
  q.reorder(b, a); assert.deepEqual(q.state.history, history); assert.deepEqual(q.state.upcoming, upcoming)
  assert.deepEqual(playlistRecord(q.state).items.map(mediaIdentity), q.state.items.map((i) => i.id))
  assert.equal(readPlaylistRowDrop({ types: [FILE_ENTRY_MIME], getData: () => a }), null)
  assert.equal(readPlaylistRowDrop({ types: [PLAYLIST_ROW_MIME], getData: () => a }), a)
  q.dispose()
})

test('nested network playlists are rejected while one audio HLS source remains one queue item', async () => {
  const q = createAudioPlaylist()
  const result = await importPlaylist(location, { audio: q,
    filesystem: { readText: async () => ({ ok: true, content: '#EXTM3U\nhttps://example.com/nested.m3u\nhttps://example.com/nested.m3u8\nhttps://example.com/radio.m3u8\n' }) },
    media: { getMetadata: async (source) => ({ ok: true, kind: 'audio', format: source.url.includes('radio') ? 'hls' : 'mp3' }) } })
  assert.equal(result.imported, 1); assert.equal(result.skipped, 2)
  assert.equal(q.state.items[0].url, 'https://example.com/radio.m3u8'); assert.equal(q.state.autoplay, false)
  q.dispose()
})

test('versioned persistence survives recreation with offline SFTP, no autoplay/session/transient fields, and safe corruption', () => {
  const q = createAudioPlaylist(); q.add([file('a.flac'), url]); q.play(q.state.items[0].id); q.setShuffle(true); q.state.repeat = 'all'
  Object.assign(q.state.items[0], { preparedSource: 'vesperwind://temporary', error: 'error', loading: true, nativeSessionId: 'private', chapters: [1] })
  const saved = JSON.stringify(playlistRecord(q.state))
  assert.doesNotMatch(saved, /temporary|nativeSessionId|chapters|autoplay|loading|error|upcoming|historyIndex/)
  const restored = createAudioPlaylist(); assert.equal(restorePlaylist(restored, saved), true)
  assert.deepEqual(restored.state.items.map(mediaIdentity), q.state.items.map(mediaIdentity))
  assert.equal(restored.state.currentId, q.state.currentId); assert.equal(restored.state.repeat, 'all'); assert.equal(restored.state.shuffle, true)
  assert.equal(restored.state.autoplay, false); assert.equal(restored.state.playRevision, 0)
  const ids = restored.state.items.map(mediaIdentity)
  restored.sync({ action: 'rename', providerId: location.providerId, sourcePath: '/Music/a.flac', destinationPath: '/Music/new.flac' })
  assert.equal(playlistRecord(restored.state).items[0].path, '/Music/new.flac')
  restored.sync({ action: 'delete', providerId: location.providerId, sourcePath: '/Music/new.flac' })
  assert.equal(playlistRecord(restored.state).items.length, 1); assert.equal(restored.state.items[0].sourceType, 'url')
  for (const bad of ['no json', '{"version":0,"items":[]}', '{"version":1,"items":[{"sourceType":"url","url":"file:///x"}]}']) assert.equal(restorePlaylist(createAudioPlaylist(), bad), false)
  assert.equal(ids.length, 2); q.dispose(); restored.dispose()
})

test('actual audio composable restores only logical current and prepares only after explicit play', async () => {
  const values = new Map(), storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) }
  let prepared = 0
  const options = { storage, metadata: null, chooseBackend: async () => 'web', prepareSource: async () => { prepared++; return { ok: true, source: 'prepared' } } }
  let scope = effectScope(), audio = scope.run(() => useAudioPlayer(options))
  audio.add([file('a.flac'), file('b.flac')]); audio.play(audio.state.items[0].id)
  await nextTick(); await nextTick(); scope.stop()
  assert.equal(prepared, 1); assert.ok(values.has(PLAYLIST_STORAGE_KEY))
  scope = effectScope(); audio = scope.run(() => useAudioPlayer(options)); await nextTick()
  assert.equal(prepared, 1); assert.equal(audio.current.value.path, '/Music/a.flac'); assert.equal(audio.state.autoplay, false)
  assert.equal(audio.current.value.preparedSource, undefined)
  audio.play(audio.current.value.id); await nextTick(); await nextTick(); assert.equal(prepared, 2)
  scope.stop()
})

test('native network open uses explicit URL source, audio-only mode and mandatory history opt-out', async () => {
  const calls = []
  const backend = new NativeMpvPlayerBackend({ kind: 'audio', autoplay: true, transport: {
    subscribe: () => () => {}, request: async (event, payload) => { calls.push({ event, payload }); return { ok: true, sessionId: payload.sessionId } },
  } })
  await backend.setSource(url)
  assert.equal(calls[0].payload.sourceType, 'url'); assert.equal(calls[0].payload.historyEnabled, false)
  assert.equal(calls[0].payload.kind, 'audio'); assert.equal(calls[0].payload.url, normalizeMediaSource(url).url)
  assert.equal('path' in calls[0].payload, false); assert.equal('geometry' in calls[0].payload, false)
  backend.close()
})

test('metadata presentation falls back through embedded tags EXTINF filename and safe URL label', () => {
  const item = { ...file('fallback.flac'), displayName: 'Imported title', tags: { title: 'Embedded title', artist: 'Artist', album: 'Album' } }
  assert.equal(trackTitle(item), 'Embedded title'); assert.equal(trackLabel(item), 'Artist — Embedded title')
  delete item.tags.title; assert.equal(trackTitle(item), 'Imported title'); delete item.displayName; assert.equal(trackTitle(item), 'fallback.flac')
  assert.equal(trackTitle(url), 'example.com/a/stream')
})

test('URL routing waits for probe kind, pauses persistent audio only for foreground video, and respects cancellation', async () => {
  const events = []
  let result = { ok: true, kind: 'audio', live: true }
  const open = createSourceOpener({ probe: async (source) => { events.push('probe'); assert.equal(source.sourceType, 'url'); return result },
    beforePlayback: async (kind) => events.push(`pause:${kind}`), open: async (_, metadata) => events.push(`open:${metadata.kind}`) })
  await open(url); assert.deepEqual(events, ['probe', 'open:audio'])
  events.length = 0; result = { ok: true, kind: 'video' }; await open(url)
  assert.deepEqual(events, ['probe', 'pause:video', 'open:video'])
  events.length = 0; result = { ok: true }; await assert.rejects(open(url), /Unable to inspect/)
  assert.deepEqual(events, ['probe'])
  const controller = new AbortController(); controller.abort(); events.length = 0
  assert.equal(await open(url, { signal: controller.signal }), false)
  assert.deepEqual(events, ['probe'])
})

test('active URL tags and EOF accept the explicit source identity and ignore a stale finished track', () => {
  const q = createAudioPlaylist(); q.add([url, file('next.flac')]); const [first, second] = q.state.items
  q.play(first.id)
  q.acceptState(first.id, { source: first.id, status: 'playing', duration: 20, tags: { title: 'Live title' } })
  assert.equal(first.tags.title, 'Live title'); assert.equal(first.duration, 20)
  q.ended({ source: first.id }); assert.equal(q.state.currentId, second.id)
  const revision = q.state.playRevision
  q.ended({ source: first.id }); assert.equal(q.state.playRevision, revision)
  q.dispose()
})
