import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { computed, reactive, ref, watch } from 'vue'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'
import { getEditorLanguage } from '../src/utils/editorLanguages.js'
import { createDefaultSettings } from '../shared/defaultSettings.js'
import { formatText } from '../src/editor/formatting/prettier.js'
import { prepareTextSave, registerSaveFormatter } from '../src/editor/formatting/saveFormatting.js'

const source = (await fs.readFile(new URL('../src/composables/useEditorWorkspace.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '').replace('export const useEditorWorkspace', 'const useEditorWorkspace')
const fixture = (formatOnSave = true) => {
  const writes = [], creations = [], settings = ref(createDefaultSettings())
  settings.value.editor.formatting.formatOnSave = formatOnSave
  const io = { readTextFile: async () => ({ ok: true, content: 'const x={a:1}', modifiedAt: 1 }),
    writeTextFile: async (path, content, provider) => { writes.push({ path, content, provider }); return { ok: true, modifiedAt: 2 } } }
  const dependencies = { computed, reactive, ref, watch, entryChange: ref(null), relocatePath: (p) => p,
    getEditorLanguage, getDocumentHandler, useTextFiles: () => io, settings,
    prepareTextSave, media: {}, filesystem: { createFile: async (...args) => { creations.push(args); return { ok: true } }, remove: async () => {} } }
  const factory = vm.compileFunction(`${source}\nreturn useEditorWorkspace`, Object.keys(dependencies))(...Object.values(dependencies))
  return { workspace: factory(), writes, creations, settings }
}
const open = async (f, name = 'test.js') => {
  const tab = await f.workspace.openFile({ type: 'text', filesystemId: 'local', node: { path: `/safe/${name}`, name } })
  f.workspace.updateContent(tab.id, 'const x={a:2}')
  return tab
}
test('every save captures formatted content after model synchronization and becomes Saved', async () => {
  const unregister = registerSaveFormatter(async (tab, fileName, settings) => {
    const result = await formatText({ text: tab.content, fileName, settings })
    return { content: result.text, serialized: result.text }
  })
  try {
    for (const mode of ['save', 'save-as', 'save-and-close']) {
      const f = fixture(), tab = await open(f)
      const destination = mode === 'save-as' ? { providerId: 'sftp:test', directoryPath: '/remote', path: '/remote/copy.js', name: 'copy.js' } : null
      const result = await f.workspace.saveTab(tab.id, destination)
      assert.equal(result.ok, true)
      assert.equal(f.writes[0].content, 'const x = { a: 2 };\n')
      assert.equal(tab.content, f.writes[0].content); assert.equal(tab.savedContent, tab.content); assert.equal(tab.dirty, false)
      if (destination) assert.deepEqual(f.writes[0], { path: '/remote/copy.js', provider: 'sftp:test', content: tab.content })
      if (mode === 'save-and-close') { f.workspace.closeTab(tab.id); assert.equal(f.workspace.tabs.value.length, 0) }
    }
  } finally { unregister() }
})

test('disabled Prettier bypasses the formatter for Save, Save As and Save and Close, including invalid syntax', async () => {
  const unregister = registerSaveFormatter(() => { assert.fail('disabled formatter was invoked') })
  try {
    for (const mode of ['save', 'save-as', 'save-and-close']) {
      const f = fixture(), tab = await open(f)
      Object.assign(f.settings.value.editor.formatting, { enabled: false, useTabs: true, tabWidth: 8 })
      f.workspace.updateContent(tab.id, 'const = {')
      const destination = mode === 'save-as'
        ? { providerId: 'sftp:test', directoryPath: '/remote', path: '/remote/copy.js', name: 'copy.js' } : null
      assert.equal((await f.workspace.saveTab(tab.id, destination)).ok, true)
      assert.equal(f.writes[0].content, 'const = {')
      assert.equal(tab.savedContent, tab.content)
      assert.equal(tab.dirty, false)
      assert.equal(tab.saveError, null)
      assert.equal(f.settings.value.editor.formatting.formatOnSave, true)
      assert.equal(f.settings.value.editor.formatting.useTabs, true)
      assert.equal(f.settings.value.editor.formatting.tabWidth, 8)
      if (mode === 'save-and-close') { f.workspace.closeTab(tab.id); assert.equal(f.workspace.tabs.value.length, 0) }
    }
  } finally { unregister() }
})

test('reenabling Prettier restores format-on-save immediately with the retained options', async () => {
  let calls = 0
  const unregister = registerSaveFormatter(async (tab, fileName, settings) => {
    calls++
    const result = await formatText({ text: tab.content, fileName, settings })
    return { content: result.text, serialized: result.text }
  })
  try {
    const f = fixture(), tab = await open(f)
    Object.assign(f.settings.value.editor.formatting, { enabled: false, semi: false })
    assert.equal((await f.workspace.saveTab(tab.id)).ok, true)
    assert.equal(calls, 0)
    f.settings.value.editor.formatting.enabled = true
    f.workspace.updateContent(tab.id, 'const x={a:3}')
    assert.equal((await f.workspace.saveTab(tab.id)).ok, true)
    assert.equal(calls, 1)
    assert.equal(f.writes.at(-1).content, 'const x = { a: 3 }\n')
  } finally { unregister() }
})

test('disabled Prettier saves without a mounted Monaco adapter; missing enabled keeps legacy behavior', async () => {
  const tab = { type: 'text', fileName: 'legacy.js' }
  assert.equal(await prepareTextSave(tab, null, { enabled: false, formatOnSave: true }), null)
  await assert.rejects(prepareTextSave(tab, null, { formatOnSave: true }), { code: 'EFORMAT' })
})
test('formatting errors cancel Save As before destination creation, preserve dirty input and keep the tab', async () => {
  const unregister = registerSaveFormatter(async () => { throw Object.assign(new Error('Formatting failed: syntax error'), { code: 'EFORMAT' }) })
  try {
    const f = fixture(), tab = await open(f), before = tab.content
    const result = await f.workspace.saveTab(tab.id, { providerId: 'local', directoryPath: '/safe', name: 'copy.js', path: '/safe/copy.js' })
    assert.equal(result.ok, false); assert.equal(tab.saveError.code, 'EFORMAT')
    assert.equal(tab.content, before); assert.equal(tab.dirty, true); assert.equal(tab.saving, false)
    assert.equal(f.writes.length, 0); assert.equal(f.creations.length, 0); assert.equal(f.workspace.tabs.value.length, 1)
  } finally { unregister() }
})
test('format/save lock prevents concurrent saves and closing; unsupported files save normally', async () => {
  let release
  const unregister = registerSaveFormatter(() => new Promise((resolve) => { release = resolve }))
  try {
    const f = fixture(), tab = await open(f), pending = f.workspace.saveTab(tab.id)
    assert.equal(tab.saving, true)
    assert.equal((await f.workspace.saveTab(tab.id)).ok, false)
    f.workspace.closeTab(tab.id); assert.equal(f.workspace.tabs.value.length, 1)
    release({ content: 'const x = { a: 2 };\n', serialized: 'const x = { a: 2 };\n' })
    assert.equal((await pending).ok, true); assert.equal(f.writes.length, 1)
    const unsupported = fixture(), rust = await open(unsupported, 'test.rs')
    assert.equal((await unsupported.workspace.saveTab(rust.id)).ok, true)
    assert.equal(unsupported.writes[0].content, 'const x={a:2}')
  } finally { unregister() }
})
test('Save As chooses the destination parser and format-on-save off leaves content untouched', async () => {
  let parserName
  const unregister = registerSaveFormatter(async (tab, fileName) => { parserName = fileName; return { content: tab.content, serialized: tab.content } })
  try {
    const f = fixture(), tab = await open(f, 'test.txt')
    await f.workspace.saveTab(tab.id, { providerId: 'local', directoryPath: '/safe', name: 'copy.js', path: '/safe/copy.js' })
    assert.equal(parserName, 'copy.js')
    assert.equal(tab.language, 'javascript')
    parserName = null
    const plain = fixture(false), js = await open(plain)
    assert.equal((await plain.workspace.saveTab(js.id)).ok, true); assert.equal(parserName, null)
    assert.equal(plain.writes[0].content, js.content)
  } finally { unregister() }
})

test('bare CR serialization is retained after manual formatting with format-on-save off', async () => {
  const f = fixture(false), tab = await open(f)
  f.workspace.updateContent(tab.id, 'const x = 2;\n')
  tab.formattingEol = 'cr'
  assert.equal((await f.workspace.saveTab(tab.id)).ok, true)
  assert.equal(f.writes[0].content, 'const x = 2;\r')
  assert.equal(tab.content, tab.savedContent)
  assert.equal(tab.dirty, false)
})

test('Save As cannot replace another open tab buffer or create a colliding Monaco URI', async () => {
  const f = fixture(false), source = await open(f, 'source.js')
  const target = await open(f, 'target.js')
  const response = await f.workspace.saveTab(source.id, { providerId: 'local', path: '/safe/target.js',
    directoryPath: '/safe', name: 'target.js' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'EFILE_OPEN')
  assert.equal(f.writes.length, 0)
  assert.equal(f.creations.length, 0)
  assert.equal(target.dirty, true)
})
