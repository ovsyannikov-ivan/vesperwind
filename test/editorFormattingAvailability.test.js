import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { ref, watch } from 'vue'
import { createDefaultSettings } from '../shared/defaultSettings.js'
import { FORMATTING_LANGUAGES, getFormattingParser } from '../src/editor/formatting/parsers.js'
import { formatText } from '../src/editor/formatting/prettier.js'

// Execute the component's formatting methods and settings watcher, replacing
// only the DOM-bound Monaco surface and worker transport with test doubles.
const source = await fs.readFile(new URL('../src/components/MonacoEditor.vue', import.meta.url), 'utf8')
const methods = source.slice(source.indexOf('const requestFormatting ='), source.indexOf('const setIndentation ='))
const context = source.slice(source.indexOf('const isFormattingEnabled ='), source.indexOf('const scheduleModelSync ='))
const settingsWatcher = source.match(/^watch\(isFormattingEnabled,.*$/m)[0]
const fixture = ({ enabled = true, worker = formatText } = {}) => {
  const settings = ref(createDefaultSettings())
  settings.value.editor.formatting.enabled = enabled
  const tab = { id: 'test', type: 'text', fileName: 'test.js', content: 'const x={a:1}' }
  const model = { getValue: () => tab.content, getVersionId: () => 1, isDisposed: () => false,
    getOffsetAt: () => 0, getEOL: () => '\n' }
  const props = { activeTab: tab, tabs: [tab] }, providers = new Map(), actions = []
  let supported = false, calls = 0, saveAdapter
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }), focus() {},
    createContextKey: () => ({ set: value => { supported = value } }),
    addAction: action => { actions.push(action); return { dispose() {} } } }
  const dependencies = { props, settings, watch, editor, models: new Map([[tab.id, model]]),
    getOrCreateModel: () => model, FORMATTING_LANGUAGES, getFormattingParser,
    disposables: [], formattingProviders: [],
    monaco: { KeyMod: {}, KeyCode: {}, languages: { registerDocumentFormattingEditProvider: (id, provider) => {
      assert.equal(providers.has(id), false, 'duplicate provider')
      providers.set(id, provider)
      return { dispose: () => providers.delete(id) }
    } } },
    formatInWorker: request => { calls++; return worker(request) },
    applyFormattedText: (_model, result) => { tab.content = result.text; return result.text },
    replacementEdit: (_model, text) => ({ text }), emit() {}, emitHistoryState() {}, emitStatus() {},
    registerSaveFormatter: adapter => { saveAdapter = adapter } }
  const api = vm.compileFunction(`let formatterContext, unregisterFormatter, formattingGeneration = 0
    ${context}\n${methods}\nconst stop = ${settingsWatcher}
    registerFormatters()
    return { formatDocument, stop }`, Object.keys(dependencies))(...Object.values(dependencies))
  return { ...api, settings, tab, model, providers, actions, supported: () => supported, calls: () => calls,
    saveAdapter: (...args) => saveAdapter(...args) }
}

test('manual formatting, action availability and providers follow enable/disable without remounting', async () => {
  const f = fixture({ enabled: false })
  try {
    assert.equal(f.providers.size, 0)
    assert.equal(f.supported(), false)
    await f.formatDocument()
    assert.equal(f.calls(), 0)
    assert.equal(f.tab.content, 'const x={a:1}')
    f.settings.value.editor.formatting.enabled = true
    assert.equal(f.providers.size, FORMATTING_LANGUAGES.length)
    assert.equal(f.supported(), true)
    const staleProvider = f.providers.get('javascript')
    const edits = await staleProvider.provideDocumentFormattingEdits(f.model, {}, {})
    assert.equal(edits[0].text, 'const x = { a: 1 };\n')
    assert.equal(f.tab.content, 'const x={a:1}', 'provider mutated the model before Monaco applied edits')
    await f.actions[0].run()
    assert.equal(f.tab.content, 'const x = { a: 1 };\n')
    f.settings.value.editor.formatting.enabled = false
    assert.equal(f.providers.size, 0)
    assert.equal(f.supported(), false)
    await f.actions[0].run()
    assert.equal((await staleProvider.provideDocumentFormattingEdits(f.model, {}, {})).length, 0)
    assert.equal(await f.saveAdapter(f.tab, f.tab.fileName, f.settings.value.editor.formatting), null)
    assert.equal(f.calls(), 2)
    f.settings.value.editor.formatting.enabled = true
    assert.equal(f.providers.size, FORMATTING_LANGUAGES.length)
    assert.equal(f.actions.length, 1, 'toggle duplicated the editor action')
  } finally { f.stop() }
})

test('disabling during a pending manual or provider request discards its result even after reenabling', async () => {
  for (const entry of ['manual', 'provider', 'save']) {
    let finish
    const f = fixture({ worker: () => new Promise(resolve => { finish = resolve }) })
    try {
      const pending = entry === 'manual' ? f.formatDocument() : entry === 'provider'
        ? f.providers.get('javascript').provideDocumentFormattingEdits(f.model, {}, {})
        : f.saveAdapter(f.tab, f.tab.fileName, f.settings.value.editor.formatting)
      const settled = pending.then(result => ({ result }), error => ({ error }))
      f.settings.value.editor.formatting.enabled = false
      f.settings.value.editor.formatting.enabled = true
      finish({ text: 'const x = { a: 1 };\n', cursorOffset: 0 })
      const output = await settled
      if (entry === 'save') assert.equal(output.error.code, 'EFORMAT_DISABLED')
      assert.equal(f.tab.content, 'const x={a:1}')
      assert.equal(f.tab.formatting || false, false)
      assert.equal(f.tab.saveError || null, null)
    } finally { f.stop() }
  }
})
