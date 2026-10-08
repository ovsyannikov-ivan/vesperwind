import test from 'node:test'
import assert from 'node:assert/strict'
import { formatText } from '../src/editor/formatting/prettier.js'
import { getFormattingParser } from '../src/editor/formatting/parsers.js'
import { DEFAULT_FORMATTING, normalizeFormatting } from '../shared/editorFormatting.js'
import { createDefaultSettings, normalizeSettings } from '../shared/defaultSettings.js'
import { editorThemes, loadEditorTheme, applyEditorTheme, resolveThemeId } from '../src/editor/themes/registry.js'
import { contrastRatio } from '../src/editor/themes/compatibility.js'

test('editor settings defaults, validation and migration preserve customized editable files', () => {
  const defaults = createDefaultSettings()
  assert.equal(defaults.editor.theme, 'auto')
  assert.deepEqual(defaults.editor.formatting, DEFAULT_FORMATTING)
  assert.equal(normalizeSettings({ editor: { theme: 'one-dark-pro' } }).editor.theme, 'one-dark-pro')
  assert.equal(normalizeSettings({ editor: { theme: '../../arbitrary' } }).editor.theme, 'auto')
  assert.deepEqual(normalizeSettings({ version: 6, editor: { editableFiles: ['.js'] } }).editor.editableFiles, ['.js'])
  for (const [key, values] of Object.entries({ printWidth: [39, 301, '100', 41.5], tabWidth: [0, 9, '2', 2.5],
    trailingComma: ['bad', 1], arrowParens: ['bad', false], endOfLine: ['bad', null], semi: ['false', 0],
    enabled: ['false', 0, null] })) {
    for (const value of values) assert.equal(normalizeFormatting({ [key]: value })[key], DEFAULT_FORMATTING[key])
  }
  assert.equal(normalizeFormatting({ semi: false }).semi, false)
  assert.equal(normalizeSettings({ version: 1 }).version, 7)
})

test('Prettier is enabled for legacy settings; disabling preserves dependent options', () => {
  for (const value of [{}, { version: 6 }, { version: 7, editor: { formatting: { formatOnSave: true } } }]) {
    assert.equal(normalizeSettings(value).editor.formatting.enabled, true)
  }
  const options = { ...DEFAULT_FORMATTING, enabled: false, formatOnSave: true, useTabs: true, tabWidth: 8,
    printWidth: 80, semi: false, singleQuote: true, trailingComma: 'none', arrowParens: 'avoid', endOfLine: 'crlf' }
  assert.deepEqual(normalizeSettings({ editor: { formatting: options } }).editor.formatting, options)
  assert.deepEqual(normalizeFormatting({ ...options, enabled: true }), { ...options, enabled: true })
})

const samples = [
  ['sample.js', 'const x={a:1,b:"two"}', 'const x = { a: 1, b: "two" };\n'],
  ['sample.jsx', 'const x=<div foo="x">hello</div>', 'const x = <div foo="x">hello</div>;\n'],
  ['sample.ts', 'const x:number=1', 'const x: number = 1;\n'],
  ['sample.tsx', 'const x: JSX.Element=<div/>', 'const x: JSX.Element = <div />;\n'],
  ['sample.json', '{"x":1}', '{ "x": 1 }\n'],
  ['sample.html', '<div><span>hi</span></div>', '<div><span>hi</span></div>\n'],
  ['sample.css', '.x{color:red}', '.x {\n  color: red;\n}\n'],
  ['sample.scss', '.x{&:hover{color:red}}', '.x {\n  &:hover {\n    color: red;\n  }\n}\n'],
  ['sample.md', '# Title\n\n-   item', '# Title\n\n- item\n'],
  ['sample.yml', 'items: [1,2,3]', 'items: [1, 2, 3]\n'],
]
for (const [fileName, text, expected] of samples) test(`bundled Prettier formats ${fileName}`, async () => {
  assert.equal((await formatText({ fileName, text })).text, expected)
})
test('Vue SFC formats embedded TypeScript, template and SCSS together', async () => {
  const text = '<script setup lang="ts">const x:number=1</script><template><div>{{x}}</div></template><style lang="scss">.x{color:red;&:hover{color:blue}}</style>'
  const result = await formatText({ text, fileName: 'test.vue' })
  assert.equal(result.text, '<script setup lang="ts">\nconst x: number = 1;\n</script>\n<template>\n  <div>{{ x }}</div>\n</template>\n<style lang="scss">\n.x {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n</style>\n')
})
test('formatter uses its settings, maps the cursor and rejects syntax errors without changing input', async () => {
  const text = 'const hello={name:"value"}'
  const result = await formatText({ text, fileName: 'test.js', cursorOffset: 9,
    settings: { semi: false, singleQuote: true, useTabs: true, tabWidth: 4 } })
  assert.equal(result.text, "const hello = { name: 'value' }\n")
  assert.equal(result.text.slice(0, result.cursorOffset), text.slice(0, 9))
  const broken = 'const = {'
  await assert.rejects(formatText({ text: broken, fileName: 'broken.js' }))
  assert.equal(broken, 'const = {')
  for (const fileName of ['test.rs', 'test.py', 'test.php', 'test.sql']) {
    assert.equal(getFormattingParser(fileName), null)
    assert.deepEqual(await formatText({ text: broken, fileName }), { text: broken, cursorOffset: -1, supported: false })
  }
  for (const [endOfLine, ending] of [['lf', '\n'], ['crlf', '\r\n'], ['cr', '\r']])
    assert.equal((await formatText({ text: 'const x=1', fileName: 'test.js', settings: { endOfLine } })).text, `const x = 1;${ending}`)
})
test('curated themes have unique IDs, valid data, visible custom tokens and cached loaders', async () => {
  assert.equal(new Set(editorThemes.map((item) => item.id)).size, editorThemes.length)
  assert.equal(await loadEditorTheme('missing'), null)
  for (const item of editorThemes.filter((item) => item.id !== 'auto')) {
    assert.ok(item.name)
    const theme = await item.loader()
    assert.ok(['vs', 'vs-dark', 'hc-black', 'hc-light'].includes(theme.base))
    assert.equal(typeof theme.inherit, 'boolean'); assert.ok(Array.isArray(theme.rules)); assert.equal(typeof theme.colors, 'object')
    const compatible = await loadEditorTheme(item.id)
    for (const color of Object.values(compatible.colors)) assert.equal(typeof color, 'string')
    for (const key of ['editor.background', 'editor.foreground']) if (compatible.colors[key])
      assert.match(compatible.colors[key], /^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
    for (const rule of compatible.rules) {
      for (const key of ['foreground', 'background']) if (rule[key])
        assert.match(rule[key], /^[0-9a-f]{6}([0-9a-f]{2})?$/i, `${item.id}: ${key}`)
    }
    assert.equal(await loadEditorTheme(item.id), compatible)
    if (item.id !== 'vesperwind-dark-2026') {
      for (const token of ['keyword.import', 'keyword.declaration', 'constant', 'function', 'variable', 'string.vue']) {
        const rule = compatible.rules.findLast((rule) => rule.token === token)
        assert.ok(contrastRatio(rule.foreground, compatible.colors['editor.background']) >= 4.5, `${item.id}: ${token}`)
      }
    }
  }
})
test('auto follows the app, fixed themes stay fixed, and registration happens only once', async () => {
  const definitions = [], changes = []
  const monaco = { editor: { defineTheme: (id) => definitions.push(id), setTheme: (id) => changes.push(id) } }
  await applyEditorTheme(monaco, 'one-dark-pro', 'dark')
  await applyEditorTheme(monaco, 'one-dark-pro', 'light')
  assert.deepEqual(definitions, ['one-dark-pro']); assert.deepEqual(changes, ['one-dark-pro', 'one-dark-pro'])
  assert.equal(resolveThemeId('auto', 'light'), 'vs')
  assert.equal(resolveThemeId('auto', 'dark'), 'vesperwind-dark-2026')
  await applyEditorTheme(monaco, 'missing', 'light'); assert.equal(changes.at(-1), 'vs')
  await applyEditorTheme(monaco, 'nord', 'dark', () => false); assert.equal(changes.at(-1), 'vs')
})
