import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// A separate settings path and module instance: the server caches settings.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-newer-settings-'))
const settingsPath = path.join(directory, 'settings.json')
const newer = '{"version":99,"connections":[{"id":"x","protocol":"webdav"}],"future":true}'
await fs.writeFile(settingsPath, newer)
process.env.VESPERWIND_SETTINGS_PATH = settingsPath
const { loadSettings, resetSettings, saveSettings } = await import('../server/settings.js?newer-version')

test.after(() => fs.rm(directory, { recursive: true, force: true }))

test('settings from a newer Vesperwind are never normalized, saved over or reset', async () => {
  for (const action of [() => loadSettings(), () => saveSettings({ appearance: { theme: 'dark' } }), () => resetSettings()]) {
    await assert.rejects(action(), { code: 'ESETTINGS_NEWER_VERSION', message: /newer version of Vesperwind/ })
  }
  assert.equal(await fs.readFile(settingsPath, 'utf8'), newer)
})
