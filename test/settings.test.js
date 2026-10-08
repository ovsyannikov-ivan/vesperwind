import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-settings-'))
const fixturePath = path.join(fixtureDirectory, 'settings.json')
process.env.VESPERWIND_SETTINGS_PATH = fixturePath

const {
  loadSettings,
  resetSettings,
  saveSettings,
  settingsFilePath,
} = await import('../server/settings.js')

test.after(async () => {
  await fs.rm(fixtureDirectory, { recursive: true, force: true })
})

test('creates a versioned JSON settings file with defaults', async () => {
  const settings = await loadSettings()
  const storedSettings = JSON.parse(await fs.readFile(fixturePath, 'utf8'))

  assert.equal(settingsFilePath, fixturePath)
  assert.equal(settings.version, 7)
  assert.equal(settings.appearance.theme, 'system')
  assert.equal(settings.appearance.locale, '')
  assert.deepEqual(settings.filesystem.hiddenNameSuffixes, ['.localized'])
  assert.ok(settings.editor.editableFiles.includes('.vue'))
  assert.deepEqual(storedSettings, settings)
})

test('normalizes and persists updated hidden suffixes', async () => {
  const settings = await saveSettings({
    appearance: {
      theme: 'dark',
      locale: 'en-GB',
    },
    filesystem: {
      hiddenNameSuffixes: [' .localized ', '.cache', '.CACHE', '', 42],
    },
  })
  const storedSettings = JSON.parse(await fs.readFile(fixturePath, 'utf8'))

  assert.equal(settings.appearance.theme, 'dark')
  assert.equal(settings.appearance.locale, 'en-GB')
  assert.deepEqual(settings.filesystem.hiddenNameSuffixes, ['.localized', '.CACHE'])
  assert.deepEqual(storedSettings, settings)
})

test('falls back to the system theme for unknown values', async () => {
  const settings = await saveSettings({
    appearance: {
      theme: 'sepia',
    },
    filesystem: {
      hiddenNameSuffixes: ['.localized'],
    },
  })

  assert.equal(settings.appearance.theme, 'system')
  assert.equal(settings.appearance.locale, '')
})

test('can restore default settings', async () => {
  await saveSettings({ editor: { theme: 'one-dark-pro', formatting: { enabled: false, formatOnSave: true } } })
  const settings = await resetSettings()

  assert.equal(settings.appearance.theme, 'system')
  assert.equal(settings.appearance.locale, '')
  assert.deepEqual(settings.filesystem.hiddenNameSuffixes, ['.localized'])
  assert.equal(settings.editor.theme, 'auto')
  assert.equal(settings.editor.formatting.formatOnSave, false)
  assert.equal(settings.editor.formatting.enabled, true)
})

test('persists disabled Prettier and retains its options across settings loads', async () => {
  const formatting = { enabled: false, formatOnSave: true, useTabs: true, tabWidth: 8 }
  const saved = await saveSettings({ editor: { formatting } })
  const loaded = await loadSettings()
  assert.deepEqual(loaded.editor.formatting, saved.editor.formatting)
  assert.deepEqual(JSON.parse(await fs.readFile(fixturePath, 'utf8')).editor.formatting, saved.editor.formatting)
  for (const [key, value] of Object.entries(formatting)) assert.equal(loaded.editor.formatting[key], value)
})
