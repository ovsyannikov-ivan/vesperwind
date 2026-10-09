import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { createDefaultSettings, normalizeSettings } from '../shared/defaultSettings.js'

const source = (await fs.readFile(new URL('../src/components/RemoteConnectionsModal.vue', import.meta.url), 'utf8'))
  .split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm, '')
const profile = { id: 'existing', name: 'Saved', protocol: 'sftp', host: 'fixture.invalid', port: 22, username: 'fixture',
  authType: 'password', privateKeyPath: '', sshConfigHost: '', savePassword: true, saveKeyPassphrase: false, trustedFingerprint: '', initialPath: '' }
const fixture = ({ supported = true, response = { ok: true, connectionId: 'existing' }, config = [] } = {}) => {
  const settings = ref(createDefaultSettings()), saved = [], requests = [], events = [], forgotten = []
  const scope = effectScope()
  settings.value.connections = [profile]
  const dependencies = { computed, nextTick, onMounted() {}, onBeforeUnmount() {}, reactive, ref, watch,
    defineProps: () => reactive({ open: true, activePanel: 'left' }), defineEmits: () => (...args) => events.push(args),
    crypto: { randomUUID: () => 'new-stable-id' },
    useSettings: () => ({ settings, loadSettings: async () => ({ ok: true }),
      saveSettings: async value => { const clean = normalizeSettings(value); saved.push(clean); settings.value = clean; return { ok: true, settings: clean } } }),
    connectionsApi: {
      capabilities: async () => ({ ok: true, capabilities: { credentialStore: supported, sshConfig: supported } }),
      credentialStatus: async () => ({ ok: true, credentials: { password: true, keyPassphrase: false } }),
      sshConfigHosts: async () => ({ ok: true, hosts: config }),
      resolveSshHost: async alias => ({ ok: true, host: config.find(host => host.alias === alias) }),
      forgetCredential: async (...args) => { forgotten.push(args); return { ok: true } },
      connect: async (...args) => { requests.push(args); return response },
    },
  }
  const api = scope.run(() => vm.compileFunction(`${source}\nreturn { draft, password, keyPassphrase, credentials, capabilities, authNeeds, warning, select, selectConfig, newProfile, save, connect, show, forget }`, Object.keys(dependencies))(...Object.values(dependencies)))
  return { ...api, saved, requests, events, forgotten, stop: () => scope.stop() }
}
test('saved password status does not refill the input; typed secrets bypass settings and are cleared on success', async () => {
  const f = fixture()
  try {
    await f.show(); await nextTick()
    assert.equal(f.credentials.value.password, true)
    assert.equal(f.password.value, '')
    f.password.value = 'fixture-new-password'
    await f.connect()
    assert.equal(f.requests[0][1].password, 'fixture-new-password')
    assert.equal(JSON.stringify(f.saved).includes('fixture-new-password'), false)
    assert.equal(f.password.value, '')
    assert.equal(f.events.some(([name]) => name === 'connected'), true)
  } finally { f.stop() }
})
test('SSH config import reuses a stable profile ID across repeated saves and defaults new profiles to Auto', async () => {
  const host = { alias: 'production', host: 'fixture.invalid', port: 2222, username: 'fixture', identities: ['/keys/config'] }
  const f = fixture({ config: [host] })
  try {
    await f.show(); f.newProfile(); assert.equal(f.draft.authType, 'auto')
    f.selectConfig(host); await f.save(); const id = f.draft.id
    f.selectConfig(host); await f.save()
    assert.equal(f.draft.id, id)
    assert.equal(f.saved.at(-1).connections.filter(item => item.sshConfigHost === 'production').length, 1)
    assert.equal(f.draft.privateKeyPath, '', 'import must keep using live config identities')
  } finally { f.stop() }
})
test('Auto auth failure uses structured keyPassphrase needs; credential failures never claim secure saving', async () => {
  const f = fixture({ response: { ok: false, error: { code: 'EAUTHENTICATION_REQUIRED', message: 'A key passphrase is required' }, auth: { needs: 'keyPassphrase' } } })
  try {
    await f.show(); f.draft.authType = 'auto'; await nextTick(); await f.connect()
    assert.equal(f.authNeeds.value, 'keyPassphrase')
    assert.equal(f.events.some(([name]) => name === 'close'), false)
  } finally { f.stop() }
  const warning = fixture({ response: { ok: true, credentialWarning: { message: 'Store locked' } } })
  try {
    await warning.show(); await warning.connect()
    assert.match(warning.warning.value, /could not be saved securely/)
    assert.equal(warning.events.some(([name]) => name === 'close'), false)
  } finally { warning.stop() }
})
test('forget removes the chosen credential and its persistence flag without deleting the profile', async () => {
  const f = fixture()
  try {
    await f.show(); await f.forget('password')
    assert.deepEqual(f.forgotten[0], ['existing', 'password'])
    assert.equal(f.saved.at(-1).connections[0].savePassword, false)
    assert.equal(f.saved.at(-1).connections[0].id, 'existing')
  } finally { f.stop() }
})
test('unsupported browser/SEA capabilities do not request saved secrets or SSH config', async () => {
  const f = fixture({ supported: false })
  try {
    await f.show()
    assert.equal(f.capabilities.value.credentialStore, false)
    assert.equal(f.credentials.value.password, false)
    assert.equal(f.password.value, '')
  } finally { f.stop() }
})
