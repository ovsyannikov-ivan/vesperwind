import assert from 'node:assert/strict'
import test from 'node:test'
import { isEditableFile, parseEditableFilesText } from '../src/utils/editableFiles.js'
import { getEditorLanguage } from '../src/utils/editorLanguages.js'

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
  assert.equal(getEditorLanguage('App.vue'), 'html')
  assert.equal(getEditorLanguage('config.yaml'), 'yaml')
  assert.equal(getEditorLanguage('.env'), 'plaintext')
})
