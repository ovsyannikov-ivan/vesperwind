import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { readOoxmlPackage, writeOoxmlPackage, TreePackageStore, storyParagraphs, paragraphTextOf } from '@docx-editor.dev/core/store'
import { getFileOpenType } from '../src/utils/fileTypes.js'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'
import { attachDocumentRuntime, documentRuntimeCount } from '../src/modules/document/runtime.js'
import { loadDocument, saveDocument } from '../src/modules/document/services/documentFile.js'
import { convertDocumentBytes } from '../server/documentConversion.js'
import { compiledStyles } from './support/styles.js'

const fixture = (name) => fs.readFile(new URL(`./fixtures/document/${name}`, import.meta.url))
const tab = (name = 'sample.docx', provider = 'local') => ({ id: `${provider}:${name}`, filePath: `/tmp/Unicode space 目录/${name}`,
  fileName: name, filesystemId: provider, revision: 0, dirty: false, importedFrom: null })

test('DOCX uses the lazy Word handler; imports are Word tabs; existing handlers remain', () => {
  for (const name of ['sample.docx', 'sample.RTF', 'old.DOC']) assert.equal(getFileOpenType(name), 'word')
  assert.equal(getDocumentHandler('word').component.__asyncLoader instanceof Function, true)
  assert.equal(getFileOpenType('app.js', ['.js']), 'text')
  assert.equal(getFileOpenType('manual.pdf'), 'pdf')
  assert.equal(getFileOpenType('report.xlsx'), 'spreadsheet')
  assert.equal(getFileOpenType('photo.png'), 'image')
})

test('Word editor follows the live Vesperwind theme through the docx-editor colorMode prop', async () => {
  const [component, css] = await Promise.all([
    fs.readFile(new URL('../src/modules/document/WordEditor.vue', import.meta.url), 'utf8'),
    Promise.resolve(compiledStyles('src/modules/document/styles/document.scss')),
  ])
  assert.doesNotMatch(component, /\scolor-mode="(light|dark)"/)
  assert.match(component, /:color-mode="colorMode"/)
  assert.match(component, /const \{ resolvedTheme \} = useTheme\(\)/)
  assert.match(component, /resolvedTheme\.value === 'light' \? 'light' : 'dark'/)
  // docx-editor owns its light/dark tokens; the host must not pin one palette.
  assert.doesNotMatch(css, /--doc-bg\s*:/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
})

test('generated DOCX fixtures parse and preserve text, formatting, tables, images, headers, Unicode, and unknown XML', async () => {
  for (const name of ['simple', 'formatting', 'tables', 'images', 'headers-footers', 'unicode', 'advanced']) {
    const parsed = readOoxmlPackage(await fixture(`${name}.docx`))
    assert.equal(parsed.ok, true, `${name}: ${parsed.reason}`)
    const reopened = readOoxmlPackage(writeOoxmlPackage(parsed.package))
    assert.equal(reopened.ok, true, name)
    assert.equal(reopened.package.mainDocumentPart, parsed.package.mainDocumentPart)
  }
  const advanced = readOoxmlPackage(await fixture('advanced.docx'))
  const saved = readOoxmlPackage(writeOoxmlPackage(advanced.package))
  assert.equal(new TextDecoder().decode(saved.package.partBytes.get('/customXml/item1.xml')).includes('DO_NOT_REMOVE_12345'), true)
  const formatting = readOoxmlPackage(await fixture('formatting.docx'))
  assert.match(new TextDecoder().decode(formatting.package.partBytes.get('/word/document.xml')), /Bold|Italic|Underline/)
  const tables = readOoxmlPackage(await fixture('tables.docx'))
  assert.match(new TextDecoder().decode(tables.package.partBytes.get('/word/document.xml')), /Merged cells/)
  const image = readOoxmlPackage(await fixture('images.docx'))
  assert.equal([...image.package.partBytes.keys()].some((name) => name.startsWith('/word/media/')), true)
  const header = readOoxmlPackage(await fixture('headers-footers.docx'))
  assert.equal([...header.package.partBytes.keys()].some((name) => name.startsWith('/word/header')), true)
  const unicode = readOoxmlPackage(await fixture('unicode.docx'))
  assert.match(new TextDecoder().decode(unicode.package.partBytes.get('/word/document.xml')), /Привет, Иван/)
})

test('canonical OOXML edit/save/reopen keeps every fixture part and unsupported payload content', async () => {
  for (const name of ['simple', 'formatting', 'tables', 'images', 'headers-footers', 'unicode', 'advanced']) {
    const parsed = readOoxmlPackage(await fixture(`${name}.docx`))
    const main = parsed.package.parts.get(parsed.package.mainDocumentPart)
    const firstParagraph = storyParagraphs(main.root.children.find((node) => node.kind === 'body'))[0]
    const originalText = paragraphTextOf(main, firstParagraph.id)
    const store = new TreePackageStore(parsed.package, main)
    const edited = store.transact({ kind: 'body' }, (transaction) => transaction.apply({
      op: 'insertText', paragraphId: firstParagraph.id, offset: 0, text: 'Edited ',
    }))
    assert.equal(edited.ok, true, name)
    const reopened = readOoxmlPackage(writeOoxmlPackage(store.currentPackage()))
    assert.equal(reopened.ok, true, name)
    const reopenedMain = reopened.package.parts.get(reopened.package.mainDocumentPart)
    const reopenedParagraph = storyParagraphs(reopenedMain.root.children.find((node) => node.kind === 'body'))[0]
    assert.equal(paragraphTextOf(reopenedMain, reopenedParagraph.id), `Edited ${originalText}`, name)
    assert.deepEqual([...reopened.package.parts.keys()].sort(), [...parsed.package.parts.keys()].sort(), name)
    assert.deepEqual([...reopened.package.partBytes.keys()].sort(), [...parsed.package.partBytes.keys()].sort(), name)
    if (name === 'advanced') {
      const opaque = new TextDecoder().decode(reopened.package.partBytes.get('/customXml/item1.xml'))
      assert.match(opaque, /DO_NOT_REMOVE_12345/)
      assert.match(new TextDecoder().decode(reopened.package.partBytes.get('/word/document.xml')), /VesperwindBookmark|fldSimple/)
    }
  }
})

test('Local and SFTP documents use the same binary reference and save state tracks concurrent edits', async () => {
  const original = await fixture('simple.docx')
  for (const provider of ['local', 'sftp:example']) {
    const current = tab('Unicode space 目录.docx', provider)
    const calls = []
    const io = { readBinary: async (location) => { calls.push(['read', location]); return { ok: true, bytes: original, modifiedAt: 'now' } },
      writeBinary: async (location, bytes) => { calls.push(['write', location, bytes]); return { ok: true, modifiedAt: 'later' } } }
    assert.equal((await loadDocument(current, {}, io)).ok, true)
    assert.equal(current.dirty, false)
    const detach = attachDocumentRuntime(current.id, { save: async () => original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) })
    current.revision++
    current.dirty = true
    assert.equal((await saveDocument(current, null, io)).ok, true)
    assert.equal(current.dirty, false)
    assert.deepEqual(calls[0][1], { providerId: provider, path: current.filePath })
    assert.deepEqual(calls[1][1], { providerId: provider, path: current.filePath })
    io.writeBinary = async () => ({ ok: false, error: { message: 'disk full' } })
    current.dirty = true
    assert.equal((await saveDocument(current, null, io)).ok, false)
    assert.equal(current.dirty, true)
    io.writeBinary = async () => { current.revision++; return { ok: true } }
    assert.equal((await saveDocument(current, null, io)).ok, true)
    assert.equal(current.dirty, true)
    detach()
  }
  assert.equal(documentRuntimeCount(), 0)
})

test('two Word editors keep independent runtime state and dispose separately', async () => {
  const a = attachDocumentRuntime('a', { save: async () => Uint8Array.of(1) })
  const b = attachDocumentRuntime('b', { save: async () => Uint8Array.of(2) })
  assert.equal(documentRuntimeCount(), 2)
  a()
  assert.equal(documentRuntimeCount(), 1)
  b()
  assert.equal(documentRuntimeCount(), 0)
})

test('RTF and DOC imports never save over their source; Save As writes a DOCX destination', async () => {
  const converted = await fixture('simple.docx')
  for (const format of ['rtf', 'doc']) {
    const current = tab(`original.${format}`)
    const writes = []
    const io = { readBinary: async () => ({ ok: true, bytes: await fixture(format === 'doc' ? 'simple.doc' : 'simple.rtf') }),
      writeBinary: async (location) => { writes.push(location); return { ok: true } } }
    assert.equal((await loadDocument(current, {}, io, async () => ({ ok: true, bytes: converted }))).ok, true)
    assert.equal(current.importedFrom, format.toUpperCase())
    assert.equal(current.dirty, true)
    const detach = attachDocumentRuntime(current.id, { save: async () => converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength) })
    assert.equal((await saveDocument(current, null, io)).ok, false)
    assert.equal(writes.length, 0)
    const destination = { providerId: 'sftp:example', path: `/remote/original.docx` }
    assert.equal((await saveDocument(current, destination, io)).ok, true)
    assert.deepEqual(writes, [destination])
    detach()
  }
})

test('malformed DOCX fails gracefully before mounting the editor', async () => {
  const current = tab()
  const result = await loadDocument(current, {}, { readBinary: async () => ({ ok: true, bytes: Uint8Array.of(1, 2, 3) }) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'EDOCX_INVALID')
})

test('local LibreOffice converts RTF and DOC through isolated temporary bytes', async (context) => {
  for (const format of ['rtf', 'doc']) {
    let bytes
    try {
      bytes = await convertDocumentBytes(await fixture(format === 'rtf' ? 'formatting.rtf' : 'simple.doc'), format)
    } catch (error) {
      if (error.code === 'ECONVERTER_MISSING') { context.skip('Optional LibreOffice is not installed'); return }
      throw error
    }
    assert.equal(readOoxmlPackage(bytes).ok, true)
  }
  const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('vesperwind-document-')).sort()
  await assert.rejects(convertDocumentBytes(Uint8Array.of(1, 2), 'docx'), /Only RTF and DOC/)
  const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('vesperwind-document-')).sort()
  assert.deepEqual(after, before)
})
