import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { useQuickLook, getQuickLookKind } from '../src/composables/useQuickLook.js'
import { canOpenQuickLook, canCloseQuickLook } from '../src/utils/quickLookKeyboard.js'
import { createPlaybackCoordinator } from '../src/player/playbackCoordination.js'
import { WebMediaPlayerBackend } from '../src/player/mediaPlayerBackend.js'
import { TEXT_PREVIEW_MAX_BYTES, decodeTextPreview } from '../shared/textPreview.js'
import { useEditorWorkspace } from '../src/composables/useEditorWorkspace.js'
import { documentRuntimeCount } from '../src/modules/document/runtime.js'
import { spreadsheetRuntimeCount } from '../src/modules/spreadsheet/runtime.js'
import { previewSheetBounds, formatPreviewCell } from '../src/modules/spreadsheet/previewGrid.js'

const entry = (name, extra = {}) => ({ name, path: `/files/${name}`, isDirectory: false, ...extra })
const context = (name, extra) => ({ node: entry(name, extra), filesystemId: 'sftp:demo' })
const source = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')

class MediaElement extends EventTarget {
  paused = true
  currentTime = 0
  duration = 30000
  volume = 1
  muted = false
  src = ''
  load() { this.dispatchEvent(new Event('loadstart')) }
  async play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute() { this.src = '' }
}

test('dispatch keeps normal media formats, configured text, and metadata fallback distinct', () => {
  const rules = ['.txt', '.log', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.vue', '.css', '.html', '.xml', '.yaml', '.yml', '.ini', '.conf', '.sql', '.sh', '.py', '.php', 'Dockerfile']
  for (const rule of rules) assert.equal(getQuickLookKind(entry(rule.startsWith('.') ? `file${rule}` : rule), rules), 'text')
  for (const [file, kind] of [['image.jpg', 'image'], ['film.mkv', 'video'], ['book.m4b', 'audio'], ['a.pdf', 'pdf'], ['a.docx', 'word'], ['a.xls', 'spreadsheet'], ['a.xlsx', 'spreadsheet'], ['a.unknown', 'metadata']]) {
    assert.equal(getQuickLookKind(entry(file), rules), kind)
  }
  assert.equal(getQuickLookKind(entry('dir', { isDirectory: true })), null)
  assert.equal(getQuickLookKind(null), null)
  assert.equal(getQuickLookKind(entry('server.log'), []), 'text')
  assert.equal(getQuickLookKind(entry('app.json')), 'text')
  assert.equal(getQuickLookKind(entry('custom.cfg'), ['.cfg']), 'text')
})

test('Space is limited to an active file panel and ignores editors, menus and dialogs', () => {
  const state = { workspaceMode: 'files', selected: entry('a.txt') }
  const event = (focus = '') => ({ key: ' ', target: { closest: (selector) =>
    selector === '.file-panel.is-active' ? { panel: true } : selector.includes(focus) && focus ? { control: true } : null } })
  assert.equal(canOpenQuickLook(event(), state), true)
  for (const focus of ['input', 'textarea', 'contenteditable', '.xterm', '.terminal-panel', '.monaco-editor', '.editor-workspace', '.word-editor', '.spreadsheet-editor', '.panel-address-form', '.modal', '[role="dialog"]', '[role="menu"]', '.dropdown-menu', 'button']) {
    assert.equal(canOpenQuickLook(event(focus), state), false, focus)
  }
  for (const patch of [{ workspaceMode: 'editor' }, { selected: null }, { selected: entry('dir', { isDirectory: true }) }, { blocked: true }, { panelVisible: false }]) {
    assert.equal(canOpenQuickLook(event(), { ...state, ...patch }), false)
  }
  assert.equal(canOpenQuickLook({ key: ' ', target: { closest: () => null } }, state), false)
  for (const patch of [{ key: 'Escape' }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(canOpenQuickLook({ ...event(), ...patch }, state), false)
  }
})

test('Escape closes temporary previews but yields to handled events and nested dialogs/menus', () => {
  const event = { key: 'Escape', target: { closest: () => null } }
  assert.equal(canCloseQuickLook(event), true)
  assert.equal(canCloseQuickLook({ ...event, defaultPrevented: true }), false)
  assert.equal(canCloseQuickLook({ ...event, key: ' ' }), false)
  assert.equal(canCloseQuickLook({ ...event, target: { closest: () => ({ menu: true }) } }), false)
})

test('A/B/C/E: opening normal video or media Quick Look pauses only audible foreground playback', async () => {
  for (const scenario of ['normal-video', 'quick-video', 'quick-audio', 'quick-image']) {
    const element = new MediaElement()
    const background = new WebMediaPlayerBackend(element)
    await background.setSource('book.m4b')
    element.currentTime = 16638
    await background.play()
    const order = []
    const playback = createPlaybackCoordinator({ pauseBackgroundAudio: () => { order.push('pause-bar'); background.pause() } })
    let foreground = null
    let foregroundPlayer = null
    const foregroundElement = new MediaElement()
    const openMedia = (request, guard) => playback.openMedia(request, async () => {
      order.push('open-existing-viewer')
      foreground = request
      if (request.node.name.endsWith('.mp4')) {
        assert.equal(element.paused, true)
        foregroundPlayer = new WebMediaPlayerBackend(foregroundElement, { autoplay: true })
        await foregroundPlayer.setSource(request.node.path)
      }
    }, guard)
    const quick = useQuickLook({ openMedia, closeMedia: () => { foregroundPlayer?.close(); foreground = null }, beforePlayback: playback.beforePlayback,
      prepareMedia: async (location) => { order.push('prepare-preview'); return { ok: true, source: location.path } } })
    if (scenario === 'normal-video') await openMedia(context('video.mp4'))
    else await quick.open(context(scenario === 'quick-video' ? 'video.mp4' : scenario === 'quick-audio' ? 'clip.mp3' : 'photo.jpg'))
    assert.equal(element.paused, scenario !== 'quick-image', scenario)
    assert.equal(element.currentTime, 16638)
    assert.equal(element.src, 'book.m4b')
    if (scenario === 'quick-image') assert.deepEqual(order, ['open-existing-viewer'])
    else assert.equal(order[0], 'pause-bar')
    if (scenario === 'quick-audio') {
      assert.equal(quick.preview.value.sourceUrl, '/files/clip.mp3')
      foregroundPlayer = new WebMediaPlayerBackend(foregroundElement, { autoplay: true, historyEnabled: false })
      await foregroundPlayer.setSource(quick.preview.value.sourceUrl)
    }
    else assert.ok(foreground)
    if (scenario !== 'quick-image') assert.equal(foregroundElement.paused, false, `${scenario}: foreground autoplay`)
    quick.close()
    foregroundPlayer?.close()
    assert.equal(element.paused, scenario !== 'quick-image')
    if (scenario !== 'quick-image') { await background.play(); assert.equal(element.paused, false) }
    background.close()
  }
})

test('D: temporary audio autoplays from the beginning and never reads/writes normal M4B resume history', async () => {
  let savedPosition = 4 * 3600 + 37 * 60 + 18
  const events = []
  const history = { request: async (_event, payload) => {
    events.push(payload)
    if (payload.event === 'open') return { ok: true, position: savedPosition }
    if (payload.event === 'pause' || payload.event === 'tick') savedPosition = payload.position
    return { ok: true }
  } }
  const tempElement = new MediaElement()
  const temporary = new WebMediaPlayerBackend(tempElement, { autoplay: true, historyEnabled: false, history })
  await temporary.setSource('book.m4b', { providerId: 'local', path: '/book.m4b' })
  assert.equal(tempElement.paused, false)
  assert.equal(tempElement.currentTime, 0)
  tempElement.dispatchEvent(new Event('loadedmetadata'))
  tempElement.currentTime = 45
  tempElement.dispatchEvent(new Event('timeupdate'))
  temporary.pause()
  temporary.close()
  assert.deepEqual(events, [])
  assert.equal(savedPosition, 16638)
  const normalElement = new MediaElement()
  const normal = new WebMediaPlayerBackend(normalElement, { autoplay: true, history })
  await normal.setSource('book.m4b', { providerId: 'local', path: '/book.m4b' })
  normalElement.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(normalElement.currentTime, 16638)
  normalElement.dispatchEvent(new Event('seeked'))
  assert.equal(normalElement.paused, false)
  normal.close()
})

test('pausing background audio cancels autoplay while resume restoration is still pending', async () => {
  let complete
  const element = new MediaElement()
  const player = new WebMediaPlayerBackend(element, { autoplay: true, history: { request: () => new Promise((resolve) => { complete = resolve }) } })
  const opening = player.setSource('book.m4b', { providerId: 'local', path: '/book.m4b' })
  await Promise.resolve()
  player.pause()
  complete({ ok: true, position: 16638 })
  await opening
  element.dispatchEvent(new Event('loadedmetadata'))
  element.dispatchEvent(new Event('seeked'))
  assert.equal(element.paused, true)
  player.close()
})

test('text is bounded before read and handles stale size metadata through the same provider API', async () => {
  const calls = []
  const io = { readText: async (location, options) => {
    calls.push([location, options])
    return location.path.endsWith('grew.txt') ? { ok: false, error: { code: 'EFILE_TOO_LARGE' } } : { ok: true, content: '<script>\n  selectable\n</script>' }
  } }
  const quick = useQuickLook({ io })
  await quick.open(context('huge.txt', { size: TEXT_PREVIEW_MAX_BYTES + 1 }), ['.txt'])
  assert.match(quick.preview.value.message, /too large/)
  assert.equal(calls.length, 0)
  assert.equal(quick.preview.value.loading, false)
  await quick.open(context('grew.txt', { size: 1 }), ['.txt'])
  assert.match(quick.preview.value.message, /too large/)
  assert.deepEqual(calls[0][0], { providerId: 'sftp:demo', path: '/files/grew.txt' })
  assert.equal(calls[0][1].maxBytes, TEXT_PREVIEW_MAX_BYTES)
  assert.equal(calls[0][1].strictText, true)
  await quick.open(context('code.txt'), ['.txt'])
  assert.equal(quick.preview.value.content, '<script>\n  selectable\n</script>')
  assert.throws(() => decodeTextPreview(Uint8Array.of(0xff)), { code: 'ETEXT_BINARY' })
  assert.throws(() => decodeTextPreview(Uint8Array.of(65, 0, 66)), { code: 'ETEXT_BINARY' })
  assert.equal(decodeTextPreview(new TextEncoder().encode('Привет\n\tworld')), 'Привет\n\tworld')
  quick.close()
})

test('F: text/PDF/DOCX/XLSX and metadata use temporary state without editor tabs or dirty runtime', async () => {
  const workspace = useEditorWorkspace()
  const initial = workspace.tabs.value.length
  const quick = useQuickLook({ io: {
    readText: async () => ({ ok: true, content: 'hello' }),
    readBinary: async (location) => ({ ok: true, bytes: new Uint8Array(await fs.readFile(new URL(location.path.endsWith('.docx') ? './fixtures/document/simple.docx' : './fixtures/spreadsheet/simple.xlsx', import.meta.url))) }),
  }, prepareMedia: async () => ({ ok: true, source: '/prepared.pdf' }) })
  for (const name of ['a.txt', 'a.pdf', 'a.docx', 'a.xlsx', 'data.unknown']) {
    await quick.open(context(name, { size: 123, modifiedAt: '2026-01-01T00:00:00Z' }), ['.txt'])
    const preview = quick.preview.value
    assert.equal(preview.error, null, name)
    assert.equal(preview.dirty, undefined, name)
    assert.equal(workspace.tabs.value.length, initial)
    assert.equal(documentRuntimeCount(), 0)
    assert.equal(spreadsheetRuntimeCount(), 0)
    if (name.endsWith('docx')) assert.ok(preview.bytes.byteLength)
    if (name.endsWith('xlsx')) assert.ok(preview.model.sheets.length)
    if (name.endsWith('unknown')) { assert.equal(preview.node.size, 123); assert.equal(preview.node.path, '/files/data.unknown'); assert.equal(preview.kind, 'metadata') }
    quick.close()
  }
})

test('closing cancels pending preparations and prevents stale media from opening', async () => {
  let release
  let opened = 0
  const playback = createPlaybackCoordinator({ pauseBackgroundAudio: () => new Promise((resolve) => { release = resolve }) })
  const quick = useQuickLook({ openMedia: (request, guard) => playback.openMedia(request, () => { opened++ }, guard), closeMedia: () => {} })
  const opening = quick.open(context('film.mp4'))
  quick.close()
  release()
  await opening
  assert.equal(opened, 0)
  assert.equal(quick.current.value, null)
})

test('binary .ts routes through the existing video entry point while source .ts stays text', async () => {
  const calls = []
  const playback = createPlaybackCoordinator({ pauseBackgroundAudio: () => { calls.push('pause') } })
  const quick = useQuickLook({ io: { readText: async () => ({ ok: false, error: { code: 'ETEXT_BINARY' } }) },
    openMedia: (request, guard) => playback.openMedia(request, () => calls.push(request.node.path), guard), closeMedia: () => calls.push('close') })
  await quick.open(context('stream.ts'), ['.ts'])
  assert.equal(quick.current.value.kind, 'video')
  assert.equal(quick.preview.value, null)
  assert.deepEqual(calls, ['pause', '/files/stream.ts'])
  quick.close()
  assert.equal(calls.at(-1), 'close')
})

test('read-only spreadsheet pagination includes sparse far cells and preserves model values', () => {
  const cell = { row: 1000000, column: 16383, value: 1234.5, style: { numberFormat: '#,##0.00' } }
  const sheet = { cells: [cell], merges: [] }
  assert.deepEqual(previewSheetBounds(sheet), { rows: 1000001, columns: 16384 })
  assert.equal(formatPreviewCell(cell), '1,234.50')
  assert.equal(formatPreviewCell({ value: null, formula: 'SUM(A1:A2)' }), '=SUM(A1:A2)')
  assert.equal(cell.value, 1234.5)
})

test('component contracts preserve existing viewer, audio autoplay/history opt-out and read-only document surfaces', async () => {
  const [shell, word, sheet, bar, manager] = await Promise.all(['src/components/QuickLookModal.vue', 'src/modules/document/WordPreview.vue', 'src/modules/spreadsheet/SpreadsheetPreview.vue', 'src/components/AudioPlayerBar.vue', 'src/components/FileManager.vue'].map(source))
  assert.match(shell, /CustomMediaPlayer kind="audio"[^>]*:autoplay="true"[^>]*:history-enabled="false"/)
  assert.match(shell, /<pre[^>]*>\{\{ preview.content \}\}/)
  assert.match(shell, /<PdfViewer/)
  assert.match(shell, /canCloseQuickLook\(event\)/)
  assert.match(shell, /emit\('close'\)/)
  assert.doesNotMatch(shell, /Monaco|EditorWorkspace|writeText|writeBinary/)
  assert.match(word, /DocxEditorRoot[^>]*mode="view"/)
  assert.doesNotMatch(word, /attachDocumentRuntime|@change|@save|DocxEditorMenu|DocxEditorToolbar/)
  assert.doesNotMatch(sheet, /[Uu]niver|attachSpreadsheetRuntime|contenteditable|@save|@change/)
  assert.match(bar, /props.audio.state.autoplay = false/)
  assert.match(bar, /player.value\?\.pause\(\)/)
  assert.match(manager, /openCoordinatedMedia\(context\)/)
  assert.match(manager, /<MediaViewerModal/)
})

test('the existing media modal honors an immediate close after its Bootstrap opening transition', async () => {
  const modal = await source('src/components/MediaViewerModal.vue')
  assert.match(modal, /const handleShown = \(\) => \{\s*if \(!props.open\) modal\?\.hide\(\)/u)
  assert.match(modal, /addEventListener\('shown.bs.modal', handleShown\)/u)
  assert.match(modal, /removeEventListener\('shown.bs.modal', handleShown\)/u)
})

test('native Quick Look audio prepares content without requesting an HTML source or entering the persistent queue', async () => {
  const calls = []
  const q = useQuickLook({ openMedia: () => { throw Error('must not insert into normal player') }, closeMedia: () => {},
    beforePlayback: async (kind) => calls.push(kind), selectBackend: async () => 'mpv',
    prepareMedia: async (location, options) => { assert.equal(options.native, true); calls.push('prepare'); return { ok: true, source: 'native-audio' } } })
  await q.open({ node: { name: 'book.m4b', path: '/book.m4b', isDirectory: false }, filesystemId: 'sftp:home' })
  assert.equal(q.preview.value.sourceUrl, 'native-audio')
  assert.equal(q.preview.value.loading, false)
  assert.deepEqual(calls, ['audio', 'prepare'])
  q.close()
})
