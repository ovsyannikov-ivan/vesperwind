import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { getFileOpenType } from '../src/utils/fileTypes.js'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'
import { getQuickLookKind } from '../src/composables/useQuickLook.js'
import { loadPresentation } from '../src/modules/presentation/presentationFile.js'
import { loadDocument, saveDocument } from '../src/modules/document/services/documentFile.js'
const source = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')
const tabOf = (provider = 'local', name = 'slides.pptx') => ({ id: 'test', filePath: `/safe/${name}`, fileName: name, filesystemId: provider })

test('PPTX is a normal read-only document and Quick Look presentation with the existing PDF renderer', async () => {
  assert.equal(getFileOpenType('deck.PPTX'), 'presentation')
  assert.equal(getQuickLookKind({ name: 'deck.pptx' }), 'presentation')
  assert.equal(getDocumentHandler('presentation').save, undefined)
  for (const name of ['legacy.doc', 'rich.rtf']) assert.equal(getQuickLookKind({ name }), 'word')
  const [workspace, viewer, preview] = await Promise.all(['src/components/EditorWorkspace.vue', 'src/components/PdfViewer.vue', 'src/components/QuickLookModal.vue'].map(source))
  assert.match(workspace, /\['pdf', 'presentation'\]\.includes\(tab\.type\)/)
  assert.match(preview, /PdfViewer v-else-if="\['pdf', 'presentation'\]\.includes\(preview\.kind\)"/)
  assert.match(viewer, /data: props\.tab\.pdfBytes\.slice\(\)/)
})

test('normal and SFTP PPTX read provider bytes and feed generated PDF bytes directly; no stale conversion cache', async () => {
  for (const provider of ['local', 'sftp:test']) {
    let version = 1, reads = 0, conversions = 0
    const io = { readBinary: async (location) => {
      assert.equal(location.providerId, provider); assert.equal(location.path, '/safe/slides.pptx'); reads++
      return { ok: true, bytes: new Uint8Array([version]) }
    } }
    const converter = async (bytes) => { conversions++; return { ok: true, bytes: new Uint8Array([37, 80, 68, 70, bytes[0]]), buildId: 'pinned-build' } }
    const tab = tabOf(provider)
    assert.equal((await loadPresentation(tab, {}, io, converter)).ok, true)
    assert.equal(tab.pdfBytes.at(-1), 1); assert.equal(tab.converterBuildId, 'pinned-build')
    version = 2
    await loadPresentation(tab, {}, io, converter)
    assert.equal(tab.pdfBytes.at(-1), 2); assert.equal(reads, 2); assert.equal(conversions, 2)
  }
})

test('closing a presentation or imported document rejects a late conversion and leaves source state untouched', async () => {
  for (const name of ['slides.pptx', 'source.doc', 'source.rtf']) {
    const tab = tabOf('sftp:test', name); const controller = new AbortController(); let finish
    const io = { readBinary: async () => ({ ok: true, bytes: new Uint8Array([1]) }) }
    const converter = () => new Promise((r) => { finish = r })
    const promise = name.endsWith('pptx') ? loadPresentation(tab, { signal: controller.signal }, io, converter)
      : loadDocument(tab, { signal: controller.signal }, io, (_bytes, _format, options) => { assert.equal(options.signal, controller.signal); return converter() })
    await new Promise((r) => setTimeout(r, 0)); controller.abort(); finish({ ok: true, bytes: new Uint8Array([2]) })
    assert.equal((await promise).error.code, 'ECANCELLED'); assert.equal(tab.pdfBytes, undefined); assert.equal(tab.bytes, undefined); assert.equal(tab.dirty, undefined)
  }
})

test('native conversion has no external Office discovery, uses direct model loader, blocks macros, updates and IPC', async () => {
  const [command, worker, host, main] = await Promise.all(['src-tauri/src/commands/document.rs', 'src-tauri/vendor/lowa/web/office_thread.js', 'src-tauri/src/office.rs', 'src-tauri/src/lib.rs'].map(source))
  assert.doesNotMatch(command, /Command|soffice|PATH|LibreOffice\.app|VESPERWIND_LIBREOFFICE/)
  assert.doesNotMatch(worker, /loadComponentFromURL/)
  assert.match(worker, /MacroExecutionMode', new z\.Any\(z\.type\.short, 0\)/)
  assert.match(worker, /UpdateDocMode', new z\.Any\(z\.type\.short, 0\)/)
  assert.match(host, /background_throttling[\s\S]*BackgroundThrottlingPolicy::Disabled/)
  assert.match(host, /NewWindowResponse::Deny/)
  assert.match(main, /starts_with\("office-converter-"\)[\s\S]*IPC is disabled/)
})

test('imported DOC and RTF keep source bytes and require Save As DOCX after LOWA output accepted by Word reader', async () => {
  const docx = new Uint8Array(await fs.readFile(new URL('./fixtures/document/simple.docx', import.meta.url)))
  for (const name of ['original.doc', 'original.rtf']) {
    const tab = tabOf('local', name); let writes = 0
    const io = { readBinary: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }), writeBinary: async () => { writes++; return { ok: true } } }
    assert.equal((await loadDocument(tab, {}, io, async () => ({ ok: true, bytes: docx }))).ok, true)
    assert.equal(tab.dirty, true); assert.equal(tab.fileName, name)
    assert.equal((await saveDocument(tab, null, io)).error.code, 'EDOCX_SAVE_AS_REQUIRED'); assert.equal(writes, 0)
  }
})


test('worker passes typed NEVER_EXECUTE and NO_UPDATE to every real loader call and aborts interactions', async () => {
  const worker = await source('src-tauri/vendor/lowa/web/office_thread.js')
  const loads = [], stores = [], port = {}, short = Symbol('UNO short')
  class Any { constructor(type, val) { this.type = type; this.val = val } }
  const model = { close() {}, load(properties) { loads.push(properties) }, storeToURL(url) { stores.push(url) } }
  const helper = {
    zetajs: { Any, type: { short }, unoObject: (_types, object) => object },
    css: { beans: { PropertyValue: class { constructor(value) { Object.assign(this, value) } } },
      task: { XInteractionAbort: { query: (continuation) => continuation } } },
    context: { getServiceManager: () => ({ createInstanceWithContext: () => model }) },
    thrPort: Object.assign(port, { postMessage() {} }),
  }
  vm.runInNewContext(worker.replace(/^import .*$/m, ''), { ZetaHelperThread: class { constructor() { return helper } } })
  for (const format of ['pptx', 'doc', 'rtf']) port.onmessage({ data: { cmd: 'convert', from: `/input.${format}`, to: '/output', target: format === 'pptx' ? 'pdf' : 'docx', id: format } })
  assert.equal(loads.length, 3); assert.equal(stores.length, 3)
  for (const properties of loads) {
    for (const name of ['MacroExecutionMode', 'UpdateDocMode']) {
      const value = properties.find((p) => p.Name === name).Value
      assert.ok(value instanceof Any); assert.equal(value.type, short); assert.equal(value.val, 0)
    }
    let aborted = false
    properties.find((p) => p.Name === 'InteractionHandler').Value.handle({ getContinuations: () => [{ select: () => { aborted = true } }] })
    assert.equal(aborted, true)
  }
})
