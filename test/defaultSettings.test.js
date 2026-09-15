import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDefaultSettings,
  normalizeSettings,
} from '../shared/defaultSettings.js'

test('uses the system color mode by default', () => {
  const settings = createDefaultSettings()

  assert.equal(settings.version, 4)
  assert.equal(settings.appearance.theme, 'system')
  assert.equal(settings.appearance.locale, '')
})

test('migrates version 1 settings and preserves filesystem filters', () => {
  const settings = normalizeSettings({
    version: 1,
    filesystem: {
      hiddenNameSuffixes: ['.localized', '.cache'],
    },
  })

  assert.equal(settings.version, 4)
  assert.equal(settings.appearance.theme, 'system')
  assert.deepEqual(settings.filesystem.hiddenNameSuffixes, ['.localized', '.cache'])
})

test('adds editable file defaults while migrating older settings', () => {
  const settings = normalizeSettings({ version: 2 })

  assert.ok(settings.editor.editableFiles.includes('.vue'))
  assert.ok(settings.editor.editableFiles.includes('.env'))
  assert.equal(settings.editor.editableFiles.includes('.pdf'), false)
})

test('normalizes editable files and removes case-insensitive duplicates', () => {
  const settings = normalizeSettings({
    editor: {
      editableFiles: ['js', '.JS', '.env', 'Dockerfile', '', '../secret'],
    },
  })

  assert.deepEqual(settings.editor.editableFiles, ['.JS', '.env', 'Dockerfile'])
})

test('preserves supported Bootstrap color modes', () => {
  assert.equal(normalizeSettings({ appearance: { theme: 'dark' } }).appearance.theme, 'dark')
  assert.equal(normalizeSettings({ appearance: { theme: 'light' } }).appearance.theme, 'light')
})

test('normalizes supported date locales and falls back to numeric format', () => {
  assert.equal(normalizeSettings({ appearance: { locale: 'RU-ru' } }).appearance.locale, 'ru-RU')
  assert.equal(normalizeSettings({ appearance: { locale: 'en-GB' } }).appearance.locale, 'en-GB')
  assert.equal(normalizeSettings({ appearance: { locale: 'de-DE' } }).appearance.locale, '')
})
