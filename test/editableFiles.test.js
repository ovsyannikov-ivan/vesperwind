import assert from 'node:assert/strict'
import test from 'node:test'
import { isEditableFile, parseEditableFilesText } from '../src/utils/editableFiles.js'
import { getEditorLanguage } from '../src/utils/editorLanguages.js'
import { htmlTokenRules } from '../src/editor/themes/htmlTokens.js'
import { CUSTOM_EDITOR_LANGUAGE_IDS } from '../src/editor/languages.js'

test('parses editable file entries separated by whitespace, commas, or semicolons', () => {
  assert.deepEqual(
    parseEditableFilesText('.js .ts, .vue\n.env;Dockerfile'),
    ['.js', '.ts', '.vue', '.env', 'Dockerfile'],
  )
})

test('matches extensions and exact special file names case-insensitively', () => {
  const rules = ['.js', '.env', 'Dockerfile']

  assert.equal(isEditableFile('main.JS', rules), true)
  assert.equal(isEditableFile('.env', rules), true)
  assert.equal(isEditableFile('.env.local', rules), false)
  assert.equal(isEditableFile('dockerfile', rules), true)
  assert.equal(isEditableFile('photo.jpg', rules), false)
})

test('maps common source file extensions to Monaco languages', () => {
  assert.equal(getEditorLanguage('server.mjs'), 'javascript')
  assert.equal(getEditorLanguage('server.cjs'), 'javascript')
  assert.equal(getEditorLanguage('App.vue'), 'vue')
  assert.equal(getEditorLanguage('types.d.ts'), 'typescript')
  assert.equal(getEditorLanguage('main.rs'), 'rust')
  assert.equal(getEditorLanguage('index.php'), 'php')
  assert.equal(getEditorLanguage('index.html'), 'html')
  assert.equal(getEditorLanguage('index.htm'), 'html')
  assert.equal(getEditorLanguage('config.yaml'), 'yaml')
  assert.equal(getEditorLanguage('Cargo.toml'), 'toml')
  assert.equal(getEditorLanguage('.env.local'), 'ini')
  assert.equal(getEditorLanguage('Dockerfile.production'), 'dockerfile')
  assert.equal(getEditorLanguage('Makefile'), 'makefile')
  assert.equal(getEditorLanguage('.gitignore'), 'ignore')
  assert.equal(getEditorLanguage('unknown.binary-format'), 'plaintext')
})

test('dark Monaco theme colors HTML tags, attributes, and values', () => {
  const rules = new Map(htmlTokenRules.map(({ token, foreground }) => [token, foreground]))
  assert.ok(rules.get('tag.html'))
  assert.ok(rules.get('attribute.name.html'))
  assert.ok(rules.get('string.html'))
  assert.notEqual(rules.get('tag.html'), rules.get('string.html'))
})

test('registers custom Monaco grammars outside the editor component', () => {
  assert.deepEqual(
    ['vue', 'toml', 'makefile', 'ignore', 'nginx', 'apache', 'groovy']
      .filter((language) => !CUSTOM_EDITOR_LANGUAGE_IDS.includes(language)),
    [],
  )
})
