import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  SETTINGS_VERSION, defaultConnectionAuthType, defaultConnectionPort, normalizeConnectionProfiles, normalizeSettings,
  resetChangedConnectionTrust,
} from '../shared/defaultSettings.js'

// Shared with src-tauri/src/settings/mod.rs; both backends must agree on every case.
const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/settings/connection-profiles.json', import.meta.url), 'utf8'))

test('connection profile normalization matches the shared JavaScript/Rust fixtures', () => {
  for (const { name, input, expected } of fixtures.normalize) {
    assert.deepEqual(normalizeConnectionProfiles(input), expected, name)
    // Normalized output is a fixed point, so repeated saves never drift.
    assert.deepEqual(normalizeConnectionProfiles(expected), expected, `${name} (fixed point)`)
  }
})

test('settings v8 SFTP profiles migrate to v9 without any change', () => {
  const v8 = fixtures.normalize.find(item => item.name === 'v8 SFTP profiles are unchanged')
  const settings = normalizeSettings({ version: 8, connections: v8.input })
  assert.equal(settings.version, 9)
  assert.equal(SETTINGS_VERSION, 9)
  assert.deepEqual(settings.connections, v8.input)
})

test('trust resets match the shared fixtures', () => {
  for (const { name, previous, next, expected } of fixtures.trustReset) {
    assert.deepEqual(resetChangedConnectionTrust(previous, next), expected, name)
  }
})

test('FTP and FTPS profiles survive repeated settings round trips and unrelated edits', () => {
  const profiles = fixtures.normalize.filter(item => /round trips|implicit anonymous/.test(item.name)).flatMap(item => item.expected)
  let settings = normalizeSettings({ connections: profiles })
  for (let i = 0; i < 3; i += 1) settings = normalizeSettings(JSON.parse(JSON.stringify({ ...settings, appearance: { theme: 'dark' } })))
  assert.deepEqual(settings.connections, profiles)
  assert.equal(JSON.stringify(settings).includes('fixture-password'), false)
})

test('defaults are offered for new profiles only', () => {
  assert.equal(defaultConnectionPort('sftp'), 22)
  assert.equal(defaultConnectionPort('ftp'), 21)
  assert.equal(defaultConnectionPort('ftps', 'explicit'), 21)
  assert.equal(defaultConnectionPort('ftps', 'implicit'), 990)
  assert.equal(defaultConnectionAuthType('sftp'), 'auto')
  assert.equal(defaultConnectionAuthType('ftp'), 'password')
  const [kept] = normalizeConnectionProfiles([{ id: 'p', name: 'P', host: 'h', port: 2990, username: 'u', protocol: 'ftps', ftpTls: 'implicit' }])
  assert.equal(kept.port, 2990)
})
