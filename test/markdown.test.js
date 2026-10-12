import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { compile } from 'sass'
import { computed, reactive, ref, watch } from 'vue'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'
import { getEditorLanguage } from '../src/utils/editorLanguages.js'
import { getEntryOpenAction, getFileOpenType } from '../src/utils/fileTypes.js'
import { getQuickLookKind, useQuickLook } from '../src/composables/useQuickLook.js'
import { createDefaultSettings } from '../shared/defaultSettings.js'
import { prepareTextSave } from '../src/editor/formatting/saveFormatting.js'
import { markdownHandler } from '../src/modules/markdown/index.js'
import { describeMarkdownText, fromEditorMarkdown, toEditorMarkdown } from '../src/modules/markdown/markdownText.js'
import { createMarkdownImageResolver, installMarkdownLinkGuard, resolveMarkdownResourcePath } from '../src/modules/markdown/markdownResources.js'
import { normalizeRenderedMarkdown, visualEditingChangesMarkdown } from '../src/modules/markdown/markdownFidelity.js'
import { loadMarkdown, MARKDOWN_MAX_BYTES } from '../src/modules/markdown/services/markdownFile.js'
import { attachMarkdownRuntime, markdownRuntimeCount } from '../src/modules/markdown/runtime.js'
import { markdownRenderingOptions } from '../src/modules/markdown/toastOptions.js'

const root = new URL('../', import.meta.url)
const source = (name) => fs.readFile(new URL(name, root), 'utf8')
const utf8 = (text) => new TextEncoder().encode(text)
const binaryIo = (bytes) => ({ readBinary: async () => ({ ok: true, bytes, modifiedAt: 'then' }) })
const markdownTab = (name = 'notes.md', provider = 'local') => ({ id: `${provider}:${name}`, filePath: `/docs/${name}`,
  fileName: name, filesystemId: provider, revision: 0, dirty: false })

test('.md and .markdown open in their own Markdown tab in any letter case; other text stays in Monaco', () => {
  for (const name of ['README.md', 'notes.MD', 'Guide.Markdown', 'x.markdown']) {
    assert.equal(getFileOpenType(name, ['.md', '.js']), 'markdown', name)
    assert.equal(getFileOpenType(name, []), 'markdown', name)
    assert.equal(getEntryOpenAction({ name }, []), 'edit', name)
  }
  for (const name of ['app.js', 'notes.txt', 'readme.mdx']) assert.notEqual(getFileOpenType(name, ['.js', '.txt', '.mdx']), 'markdown', name)
  assert.equal(getFileOpenType('app.js', ['.js']), 'text')
  assert.equal(getDocumentHandler('markdown'), markdownHandler)
  assert.equal(markdownHandler.component.__asyncLoader instanceof Function, true)
  assert.equal(markdownHandler.history, true)
})

test('Quick Look renders .md and .markdown as formatted Markdown instead of text', async () => {
  for (const name of ['a.md', 'b.MARKDOWN']) assert.equal(getQuickLookKind({ name, isDirectory: false }, ['.md']), 'markdown')
  const quick = useQuickLook({ io: { readText: async (_location, options) => ({ ok: options.strictText, content: '# Title\r\n\r\nText' }) } })
  await quick.open({ node: { name: 'notes.md', path: '/docs/notes.md', size: 20 }, filesystemId: 'sftp:demo' }, ['.md'])
  const preview = quick.preview.value
  assert.equal(preview.kind, 'markdown')
  assert.equal(preview.error, null)
  assert.equal(preview.content, '# Title\r\n\r\nText')
  assert.equal(preview.providerId, 'sftp:demo')
  assert.equal(preview.dirty, undefined)
  quick.close()

  const filePreview = await source('src/components/FilePreview.vue')
  assert.match(filePreview, /defineAsyncComponent\(\(\) => import\('\.\.\/modules\/markdown\/MarkdownPreview\.vue'\)\)/)
  assert.match(filePreview, /<MarkdownPreview v-else-if="preview\.kind === 'markdown'"/)
  const viewer = await source('src/modules/markdown/MarkdownPreview.vue')
  assert.match(viewer, /import Viewer from '@toast-ui\/editor\/viewer'/)
  assert.match(viewer, /selectable-text/)
  assert.match(viewer, /viewer\?\.destroy\(\)/)
  assert.doesNotMatch(viewer, /<pre\b/)
})

test('line endings, byte order mark and final newline survive the editor round trip without trimming', () => {
  const cases = [
    ['# A\n\ntext\n', { bom: false, eol: '\n', finalNewline: true }],
    ['# A\r\n\r\ntext\r\n', { bom: false, eol: '\r\n', finalNewline: true }],
    ['# A\r\rtext', { bom: false, eol: '\r', finalNewline: false }],
    ['\uFEFF# Привет\n\n  отступ  \n', { bom: true, eol: '\n', finalNewline: true }],
    ['', { bom: false, eol: '\n', finalNewline: false }],
  ]
  for (const [text, expected] of cases) {
    const format = describeMarkdownText(text)
    assert.deepEqual({ bom: format.bom, eol: format.eol, finalNewline: format.finalNewline }, expected, JSON.stringify(text))
    const editorText = toEditorMarkdown(text)
    assert.equal(editorText.includes('\r'), false)
    assert.equal(editorText.startsWith('\uFEFF'), false)
    assert.equal(fromEditorMarkdown(editorText, format), text, JSON.stringify(text))
  }
  const crlf = describeMarkdownText('a\r\nb\r\n')
  assert.equal(fromEditorMarkdown('a\nb edited', crlf), 'a\r\nb edited\r\n')
  assert.equal(describeMarkdownText('a\r\nb\nc\r\n').mixedLineEndings, true)
  assert.equal(fromEditorMarkdown('  spaced  ', describeMarkdownText('x')), '  spaced  ')
})

test('Markdown is read as strict UTF-8 bytes: BOM kept, other encodings and oversized files refused', async () => {
  const tab = markdownTab()
  assert.deepEqual(await loadMarkdown(tab, {}, binaryIo(utf8('\uFEFF# Заголовок\r\n'))), { ok: true })
  assert.equal(tab.content, '\uFEFF# Заголовок\r\n')
  assert.equal(tab.savedContent, tab.content)
  assert.equal(tab.textFormat.bom, true)
  assert.equal(tab.textFormat.eol, '\r\n')
  assert.equal(tab.dirty, false)

  const latin1 = markdownTab('latin1.md')
  const refused = await loadMarkdown(latin1, {}, binaryIo(new Uint8Array([0x23, 0x20, 0xe9, 0x0a])))
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'ETEXT_ENCODING')
  assert.equal(latin1.content, undefined)

  const large = await loadMarkdown(markdownTab('large.md'), {}, binaryIo(new Uint8Array(MARKDOWN_MAX_BYTES + 1)))
  assert.equal(large.error.code, 'EFILE_TOO_LARGE')

  const empty = markdownTab('empty.md')
  assert.deepEqual(await loadMarkdown(empty, {}, binaryIo(new Uint8Array())), { ok: true })
  assert.equal(empty.content, '')

  const failed = await loadMarkdown(markdownTab(), {}, { readBinary: async () => ({ ok: false, error: { code: 'ENOENT', message: 'gone' } }) })
  assert.deepEqual(failed, { ok: false, error: { code: 'ENOENT', message: 'gone' } })
})

// The real workspace composable with injected IO, as in editorSaveFormatting.test.js.
const workspaceSource = (await source('src/composables/useEditorWorkspace.js'))
  .replace(/^import .*$/gm, '').replace('export const useEditorWorkspace', 'const useEditorWorkspace')
const workspaceFixture = (file = '# Title\r\n\r\nBody\r\n', writeResult = { ok: true, modifiedAt: 2 }, onWrite = () => {}) => {
  const writes = []
  const io = { readTextFile: async () => assert.fail('Markdown is read as bytes'),
    writeTextFile: async (path, content, provider) => { writes.push({ path, content, provider }); onWrite(); return writeResult } }
  const handler = { ...markdownHandler, load: (tab, options) => loadMarkdown(tab, options, binaryIo(utf8(file))) }
  const dependencies = { computed, reactive, ref, watch, entryChange: ref(null), relocatePath: (p) => p,
    getEditorLanguage, getDocumentHandler: (id) => id === 'markdown' ? handler : getDocumentHandler(id),
    useTextFiles: () => io, settings: ref(createDefaultSettings()), prepareTextSave, media: {},
    filesystem: { createFile: async () => ({ ok: true }), remove: async () => {} } }
  const factory = vm.compileFunction(`${workspaceSource}\nreturn useEditorWorkspace`, Object.keys(dependencies))(...Object.values(dependencies))
  return { workspace: factory(), writes }
}
const openMarkdown = (f, name = 'notes.md') =>
  f.workspace.openFile({ type: 'markdown', filesystemId: 'sftp:demo', node: { path: `/docs/${name}`, name } })

test('opening is not an edit; Save writes the flushed Markdown and Save As copies untouched text exactly', async () => {
  const f = workspaceFixture()
  const tab = await openMarkdown(f)
  assert.equal(tab.type, 'markdown')
  assert.equal(tab.dirty, false)
  assert.equal(tab.content, '# Title\r\n\r\nBody\r\n')

  // An untouched document is written byte for byte, even though Prettier formats Markdown.
  const copy = { providerId: 'local', directoryPath: '/copies', path: '/copies/notes.md', name: 'notes.md' }
  assert.equal((await f.workspace.saveTab(tab.id, copy)).ok, true)
  assert.deepEqual(f.writes.at(-1), { path: '/copies/notes.md', provider: 'local', content: '# Title\r\n\r\nBody\r\n' })
  assert.equal(tab.filePath, '/copies/notes.md')
  assert.equal(tab.type, 'markdown')

  // The editor serializes lazily; Save asks it for the current Markdown first.
  let markSaved = 0
  const detach = attachMarkdownRuntime(tab.id, {
    flush: () => { tab.content = fromEditorMarkdown('# Title\n\nBody edited', tab.textFormat) },
    markSaved: () => { markSaved += 1 },
  })
  try {
    tab.revision += 1
    tab.dirty = true
    assert.equal((await f.workspace.saveTab(tab.id)).ok, true)
    assert.equal(f.writes.at(-1).content, '# Title\r\n\r\nBody edited\r\n')
    assert.equal(tab.savedContent, f.writes.at(-1).content)
    assert.equal(tab.dirty, false)
    assert.equal(markSaved, 1)
  } finally { detach() }
  assert.equal(markdownRuntimeCount(), 0)
})

test('a failed save keeps the draft and the dirty state; edits during a save stay unsaved', async () => {
  const f = workspaceFixture('text\n', { ok: false, error: { code: 'EACCES', message: 'Permission denied' } })
  const tab = await openMarkdown(f)
  const detach = attachMarkdownRuntime(tab.id, { flush: () => { tab.content = 'text draft\n' }, markSaved: () => assert.fail('not saved') })
  try {
    tab.revision += 1
    tab.dirty = true
    const result = await f.workspace.saveTab(tab.id)
    assert.equal(result.ok, false)
    assert.equal(tab.content, 'text draft\n')
    assert.equal(tab.savedContent, 'text\n')
    assert.equal(tab.dirty, true)
    assert.equal(tab.saveError.message, 'Permission denied')
  } finally { detach() }

  let edited
  const busy = workspaceFixture('text\n', { ok: true, modifiedAt: 3 }, () => { edited.revision += 1 }) // typed while the write was in flight
  edited = await openMarkdown(busy, 'busy.md')
  const stop = attachMarkdownRuntime(edited.id, { flush: () => { edited.content = 'one\n' }, markSaved: () => assert.fail('newer edits exist') })
  try {
    edited.revision += 1
    edited.dirty = true
    assert.equal((await busy.workspace.saveTab(edited.id)).ok, true)
    assert.equal(edited.savedContent, 'one\n')
    assert.equal(edited.dirty, true)
  } finally { stop() }
})

test('Markdown tabs keep their own text next to Monaco tabs and use the shared close protection', async () => {
  const f = workspaceFixture()
  const first = await openMarkdown(f, 'one.md')
  const second = await openMarkdown(f, 'two.md')
  assert.notEqual(first.id, second.id)
  first.content = 'changed'
  assert.equal(second.content, '# Title\r\n\r\nBody\r\n')

  const workspace = await source('src/components/EditorWorkspace.vue')
  // Undo/Redo serve every tab whose handler keeps its own history, through the tab's own editor.
  assert.match(workspace, /getDocumentHandler\(activeTab\.value\?\.type\)\?\.history/)
  assert.match(workspace, /specializedRefs\.get\(activeHistoryTab\.value\?\.id\)/)
  assert.match(workspace, /historyState\.value\.tabId === activeHistoryTab\.value\.id/)
  assert.match(workspace, /@history-state="updateHistoryState"/)
  assert.match(workspace, /if \(getDocumentHandler\(tab\.type\)\?\.save && tab\.dirty\)/)
})

test('the editor starts in WYSIWYG, reports only real edits and releases TOAST UI on close', async () => {
  const editor = await source('src/modules/markdown/MarkdownEditor.vue')
  assert.match(editor, /initialEditType: 'wysiwyg'/)
  assert.match(editor, /\.\.\.markdownRenderingOptions/)
  // Loading is not an edit: both ProseMirror histories start empty.
  assert.match(editor, /resetHistory\(editor\.mdEditor\.view\)/)
  assert.match(editor, /resetHistory\(editor\.wwEditor\.view\)/)
  // Returning to the unchanged document clears dirty without serializing.
  assert.match(editor, /doc\.eq\(baselines\[editorType\]\)/)
  // The Markdown mode of an unchanged file shows the source as written.
  assert.match(editor, /toEditorMarkdown\(props\.tab\.savedContent\)/)
  assert.match(editor, /vesperwind:native-edit-history/)
  assert.match(editor, /editor\?\.destroy\(\)/)
  assert.match(editor, /images\?\.dispose\(\)/)
  assert.match(editor, /resizeObserver\?\.disconnect\(\)/)
  assert.match(editor, /detachRuntime\?\.\(\)/)
  assert.match(editor, /removeEventListener\('vesperwind:native-edit-history'/)
  // The editor follows the theme through CSS variables alone, so switching keeps text, selection and history.
  assert.doesNotMatch(editor, /theme:/)
  // The mode switch reads Preview | Markdown.
  assert.match(editor, /Editor\.setLanguage\('en-US', \{ WYSIWYG: 'Preview' \}\)/)
})

test('usage statistics stay off and nothing loads from a CDN', async () => {
  assert.equal(markdownRenderingOptions.usageStatistics, false)
  const files = (await fs.readdir(new URL('src/modules/markdown/', root), { recursive: true })).filter((name) => /\.(js|vue|scss)$/.test(name))
  assert.ok(files.length >= 8)
  for (const name of files) {
    const text = await source(`src/modules/markdown/${name}`)
    assert.doesNotMatch(text, /https?:\/\/|cdn\./i, name)
  }
  const pkg = JSON.parse(await source('package.json'))
  assert.equal(pkg.dependencies['@toast-ui/editor'], '3.2.2')
  // No trim() on file text in the load/save path.
  for (const name of ['src/modules/markdown/markdownText.js', 'src/modules/markdown/services/markdownFile.js']) {
    assert.doesNotMatch(await source(name), /\.trim\(/, name)
  }
})

test('visual editing is flagged only when it would change the rendered document', () => {
  const render = (markdown) => markdown
    .replace(/^\* |^- /gm, '<li>')
    .replace(/<!--.*?-->/g, (comment) => comment)
    .replace(/\n/g, ' ')
  assert.equal(visualEditingChangesMarkdown('a\n', 'a', render), false)
  assert.equal(visualEditingChangesMarkdown('- a\n- b', '* a\n* b', render), false)
  assert.equal(visualEditingChangesMarkdown('<div>x</div>', 'x', render), true)
  assert.equal(normalizeRenderedMarkdown('<p data-nodeid="12">a\n b</p>\n<p>c</p>'), '<p>a b</p><p>c</p>')
})

test('relative images resolve from the document folder on its provider', () => {
  const doc = '/Users/ivan/Docs/guide/README.md'
  assert.equal(resolveMarkdownResourcePath('images/a.png', doc), '/Users/ivan/Docs/guide/images/a.png')
  assert.equal(resolveMarkdownResourcePath('./a.png', doc), '/Users/ivan/Docs/guide/a.png')
  assert.equal(resolveMarkdownResourcePath('../shared/b%20c.png?raw=1#x', doc), '/Users/ivan/Docs/shared/b c.png')
  assert.equal(resolveMarkdownResourcePath('/srv/img.png', doc), '/srv/img.png')
  assert.equal(resolveMarkdownResourcePath('картинки/рис.png', '/home/u/заметки.md'), '/home/u/картинки/рис.png')
  assert.equal(resolveMarkdownResourcePath('img\\a.png', 'C:\\Notes\\a.md'), 'C:\\Notes\\img\\a.png')
  assert.equal(resolveMarkdownResourcePath('D:/pics/a.png', 'C:\\Notes\\a.md'), 'D:\\pics\\a.png')
  assert.equal(resolveMarkdownResourcePath('../a.png', '\\\\server\\share\\docs\\a.md'), '\\\\server\\share\\a.png')
  for (const external of ['https://example.com/a.png', 'data:image/png;base64,AA', 'blob:x', '//cdn/a.png', '#anchor', '', null]) {
    assert.equal(resolveMarkdownResourcePath(external, doc), null, String(external))
  }
})

class FakeImage {
  tagName = 'IMG'
  dataset = {}
  title = ''
  #attributes = new Map()
  #classes = new Set()
  classList = { add: (name) => this.#classes.add(name), remove: (name) => this.#classes.delete(name), contains: (name) => this.#classes.has(name) }
  constructor (src) { this.#attributes.set('src', src) }
  getAttribute (name) { return this.#attributes.get(name) ?? null }
  setAttribute (name, value) { this.#attributes.set(name, String(value)) }
  set src (value) { this.#attributes.set('src', value) }
}

test('rendered images get prepared provider URLs; missing images stay readable placeholders', async () => {
  const previous = globalThis.MutationObserver
  globalThis.MutationObserver = class { observe () {} disconnect () {} }
  try {
    const images = [new FakeImage('images/a.png'), new FakeImage('missing.png'), new FakeImage('https://example.com/x.png')]
    const listeners = new Map()
    const root = { querySelectorAll: () => images, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) }
    const requests = []
    const resolver = createMarkdownImageResolver({
      root,
      location: () => ({ providerId: 'sftp:demo', path: '/docs/notes.md' }),
      prepare: async (location) => { requests.push(location); return location.path.endsWith('a.png') ? { ok: true, source: 'vesperwind-media://a' } : { ok: false } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, [{ providerId: 'sftp:demo', path: '/docs/images/a.png' }, { providerId: 'sftp:demo', path: '/docs/missing.png' }])
    assert.equal(images[0].getAttribute('src'), 'vesperwind-media://a')
    assert.equal(images[0].dataset.markdownReference, 'images/a.png')
    assert.equal(images[1].classList.contains('markdown-image-missing'), true)
    assert.equal(images[1].title, 'Image not found: missing.png')
    assert.equal(images[2].getAttribute('src'), 'https://example.com/x.png')
    // A prepared URL that fails to load marks the image as missing too.
    listeners.get('error')({ target: images[0] })
    assert.equal(images[0].classList.contains('markdown-image-missing'), true)
    resolver.dispose()
    assert.equal(listeners.has('error'), false)
  } finally { globalThis.MutationObserver = previous }
})

test('links inside documents never navigate the application window', () => {
  const listeners = []
  const root = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }), removeEventListener: (type, fn) => listeners.splice(listeners.findIndex((item) => item.fn === fn && item.type === type), 1) }
  const remove = installMarkdownLinkGuard(root)
  assert.deepEqual(listeners.map(({ type, capture }) => [type, capture]), [['click', true], ['auxclick', true]])
  let prevented = 0
  const event = (link) => ({ target: { closest: (selector) => selector === 'a[href]' && link ? {} : null }, preventDefault: () => { prevented++ } })
  listeners[0].fn(event(true))
  listeners[1].fn(event(true))
  listeners[0].fn(event(false))
  assert.equal(prevented, 2)
  remove()
  assert.equal(listeners.length, 0)
})

test('TOAST UI styles are scoped to Markdown surfaces and follow the theme through variables', () => {
  const css = compile(fileURLToPath(new URL('src/modules/markdown/styles/markdown.scss', root)), {
    style: 'expanded', loadPaths: [fileURLToPath(new URL('src/styles', root)), fileURLToPath(new URL('node_modules', root))],
  }).css
  assert.match(css, /\.vw-markdown \.ProseMirror\b/)
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|})\s*([^@{}\s][^{}]*)\{/g)].map((match) => match[2].trim())
  assert.ok(selectors.length > 100)
  const scoped = /^(?:\.vw-markdown\b|:root\[data-bs-theme="?dark"?\] \.vw-markdown\b|\.markdown-(?:editor|warning|preview)\b|\d+%$|from$|to$)/
  for (const selector of selectors) {
    for (const part of selector.split(',')) assert.match(part.trim(), scoped, part.trim())
  }
  // No TOAST UI dark palette: dark mode comes from Vesperwind variables.
  assert.doesNotMatch(css, /toastui-editor-dark/)
  const own = css.slice(css.indexOf('--markdown-surface'))
  assert.doesNotMatch(own.replace(/#fff\b/g, ''), /#[0-9a-f]{3,8}\b/i)
  // Content is selectable, the editor chrome is not; WebKit needs the prefix.
  assert.match(css, /\.vw-markdown \.toastui-editor-md-preview,\s*\.vw-markdown \.toastui-editor-contents \{\s*-webkit-user-select: text;\s*user-select: text;/)
  assert.match(css, /\.vw-markdown \.toastui-editor-defaultUI-toolbar,[\s\S]*?\{\s*-webkit-user-select: none;\s*user-select: none;/)
  assert.match(css, /\.vw-markdown \.toastui-editor-mode-switch \.tab-item \{\s*float: right;/)
  // Scrolling the Quick Look preview with Space does not draw a focus frame.
  assert.match(css, /\.markdown-preview:focus-visible \{\s*outline: 0;/)
})
