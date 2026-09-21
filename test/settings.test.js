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
  assert.equal(settings.version, 6)
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
  const settings = await resetSettings()

  assert.equal(settings.appearance.theme, 'system')
  assert.equal(settings.appearance.locale, '')
  assert.deepEqual(settings.filesystem.hiddenNameSuffixes, ['.localized'])
})
