import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { ref, watch, nextTick } from 'vue'
import { createDefaultSettings, normalizeSettings } from '../shared/defaultSettings.js'
import { EDITOR_FONTS, monacoTypographyOptions } from '../shared/editorTypography.js'

test('v9 migration adds 12 pt typography while preserving existing editor preferences', () => {
  const previous = { version: 9, appearance: { theme: 'dark' }, editor: {
    theme: 'dracula', editableFiles: ['.rs'], formatting: { useTabs: true, tabWidth: 4 },
  } }
  const settings = normalizeSettings(previous)
  assert.equal(settings.version, 10)
  assert.equal(settings.editor.fontFamily, 'default')
  assert.equal(settings.editor.fontSize, 12)
  assert.equal(settings.appearance.theme, 'dark')
  assert.equal(settings.editor.theme, 'dracula')
  assert.deepEqual(settings.editor.editableFiles, ['.rs'])
  assert.equal(settings.editor.formatting.useTabs, true)
  assert.equal(settings.editor.formatting.tabWidth, 4)
})

test('font choices and whole-number point sizes are validated strictly', () => {
  for (const font of EDITOR_FONTS) {
    assert.equal(normalizeSettings({ editor: { fontFamily: font.id } }).editor.fontFamily, font.id)
  }
  for (const fontFamily of [null, {}, 'Arial', '../../font', 'MENLO']) {
    assert.equal(normalizeSettings({ editor: { fontFamily } }).editor.fontFamily, 'default')
  }
  for (const fontSize of [8, 12, 14, 24, 48]) {
    assert.equal(normalizeSettings({ editor: { fontSize } }).editor.fontSize, fontSize)
  }
  for (const fontSize of [null, true, '', '14', 0, 7, 49, 14.5, NaN, Infinity]) {
    assert.equal(normalizeSettings({ editor: { fontSize } }).editor.fontSize, 12)
  }
})

test('Monaco matches native logical sizes without CSS point or Retina scaling', () => {
  const defaults = monacoTypographyOptions(createDefaultSettings().editor)
  assert.equal(defaults.fontSize, 12)
  assert.equal(defaults.lineHeight, 0)
  const larger = monacoTypographyOptions({ fontSize: 14, fontFamily: 'jetbrains-mono' })
  assert.equal(larger.fontSize, 14)
  for (const fontSize of [12, 13, 14, 15]) {
    assert.equal(monacoTypographyOptions({ fontSize }).fontSize, fontSize)
  }
  assert.equal(larger.fontFamily, `'JetBrains Mono', ${defaults.fontFamily}`)
})

test('the Monaco settings watcher applies typography to the existing editor without replacing its model', async () => {
  const source = await fs.readFile(new URL('../src/components/MonacoEditor.vue', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('const updateTypography ='), source.indexOf('const emitHistoryState ='))
  const watcher = source.match(/^watch\(\(\) => \[settings.value.editor.fontFamily,.*$/m)[0]
  const settings = ref(createDefaultSettings())
  const model = { text: 'const example = 42;', undo: ['edit'], position: { lineNumber: 1, column: 8 } }
  const options = [], calls = []
  // Any attempt to recreate a model/editor or manipulate content fails: only
  // Monaco's options/layout methods are available to the real watcher.
  const editor = { model, updateOptions: value => options.push(value), layout: () => calls.push('layout') }
  const stop = vm.compileFunction(`${method}\nreturn ${watcher}`,
    ['editor', 'settings', 'watch', 'monacoTypographyOptions'])(editor, settings, watch, monacoTypographyOptions)
  try {
    settings.value = normalizeSettings({ editor: { fontFamily: 'menlo', fontSize: 14 } })
    await nextTick()
    assert.equal(options.length, 1)
    assert.equal(options[0].fontSize, 14)
    assert.match(options[0].fontFamily, /^Menlo,/)
    assert.equal(editor.model, model)
    assert.deepEqual(model, { text: 'const example = 42;', undo: ['edit'], position: { lineNumber: 1, column: 8 } })
    settings.value = createDefaultSettings()
    await nextTick()
    assert.equal(options[1].fontSize, 12)
    assert.equal(calls.length, 2)
  } finally { stop() }
})
