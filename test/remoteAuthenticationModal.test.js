import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { createDefaultSettings, normalizeSettings } from '../shared/defaultSettings.js'
import { CERTIFICATE_REASONS, CONNECTION_PROTOCOLS, defaultConnectionPort, emptyConnectionProfile, profileFields, protocolDefinition } from '../src/components/remoteConnectionProtocols.js'

const source = (await fs.readFile(new URL('../src/components/RemoteConnectionsModal.vue', import.meta.url), 'utf8'))
  .split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm, '')
const profile = { id: 'existing', name: 'Saved', protocol: 'sftp', host: 'fixture.invalid', port: 22, username: 'fixture',
  authType: 'password', privateKeyPath: '', sshConfigHost: '', savePassword: true, saveKeyPassphrase: false, trustedFingerprint: '', initialPath: '' }
const fixture = ({ supported = true, response = { ok: true, connectionId: 'existing' }, config = [], extra = [], protocols = ['sftp', 'ftp', 'ftps'], registry = CONNECTION_PROTOCOLS, connectGate = null, status = 'disconnected', cancelSupported = true, uuid = () => 'new-stable-id' } = {}) => {
  const settings = ref(createDefaultSettings()), saved = [], requests = [], events = [], forgotten = [], cancelled = []
  const scope = effectScope()
  settings.value.connections = normalizeSettings({ connections: [...extra, profile] }).connections
  const responses = Array.isArray(response) ? [...response] : null
  const disconnected = [], statusListeners = []
  const protocolDefinitionFor = (id) => registry.find(item => item.id === id) || null
  const fieldsFor = (id) => [...profileFields('sftp').slice(0, 9), ...Object.keys(protocolDefinitionFor(id)?.fields || {})]
  const emptyFor = (id) => { const definition = protocolDefinitionFor(id); const value = { id: '', name: '', host: '', username: '', initialPath: '', savePassword: false, protocol: id, authType: definition.authTypes[0].value, ...definition.fields }; value.port = definition.defaultPort ? definition.defaultPort(value) : defaultConnectionPort(id, value.ftpTls); return value }
  const dependencies = { computed, nextTick, onMounted() {}, onBeforeUnmount() {}, reactive, ref, watch,
    CERTIFICATE_REASONS, CONNECTION_PROTOCOLS: registry, defaultConnectionPort,
    emptyConnectionProfile: registry === CONNECTION_PROTOCOLS ? emptyConnectionProfile : emptyFor,
    profileFields: registry === CONNECTION_PROTOCOLS ? profileFields : fieldsFor,
    protocolDefinition: registry === CONNECTION_PROTOCOLS ? protocolDefinition : protocolDefinitionFor,
    defineProps: () => reactive({ open: true, activePanel: 'left' }), defineEmits: () => (...args) => events.push(args),
    crypto: { randomUUID: uuid },
    useSettings: () => ({ settings, loadSettings: async () => ({ ok: true }),
      saveSettings: async value => { const clean = normalizeSettings(value); saved.push(clean); settings.value = clean; return { ok: true, settings: clean } } }),
    connectionsApi: {
      capabilities: async () => ({ ok: true, capabilities: { credentialStore: supported, sshConfig: supported, protocols } }),
      credentialStatus: async () => ({ ok: true, credentials: { password: true, keyPassphrase: false } }),
      sshConfigHosts: async () => ({ ok: true, hosts: config }),
      resolveSshHost: async alias => ({ ok: true, host: config.find(host => host.alias === alias) }),
      forgetCredential: async (...args) => { forgotten.push(args); return { ok: true } },
      connect: async (...args) => { requests.push(structuredClone(args.slice(0, 2))); if (connectGate) await connectGate; return responses ? responses.shift() : response },
      cancelConnect: async (...args) => { cancelled.push(args); return cancelSupported ? { ok: true, cancelled: true } : { ok: false, error: { code: 'ENOTSUPPORTED', message: 'Unsupported' } } },
      status: async () => ({ ok: true, status }),
      disconnect: async (...args) => { disconnected.push(args); return { ok: true } },
      onStatus: (callback) => { statusListeners.push(callback); return () => {} },
    },
  }
  const onMountedHooks = []
  dependencies.onMounted = (hook) => onMountedHooks.push(hook)
  const api = scope.run(() => vm.compileFunction(`${source}\nreturn { draft, password, keyPassphrase, credentials, capabilities, authNeeds, warning, error, select, selectConfig, newProfile, save, connect, show, forget, profiles, unsupportedProfileCount, remove, activeTab, tabs, selectTab, tabKeydown, dialog, discardAndProceed, saveAndProceed, cancelDialog, removeTrustedCertificate, dirty, close, portTouched, selectedId, connectionState, disconnect, cancelConnection, connecting, busy }`, Object.keys(dependencies))(...Object.values(dependencies)))
  return { ...api, saved, requests, events, forgotten, cancelled, disconnected, statusListeners, onMountedHooks, stop: () => scope.stop() }
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
const ftp = { id: 'router', name: 'Router', host: '192.0.2.1', port: 21, username: 'admin', authType: 'password', protocol: 'ftp',
  savePassword: true, plaintextAcknowledged: true }
const ftps = { id: 'nas', name: 'NAS', host: 'nas.invalid', port: 990, username: 'anonymous', authType: 'anonymous', protocol: 'ftps',
  ftpTls: 'implicit', tlsTrustedCertificate: 'ab'.repeat(32) }
const webdav = { id: 'dav', name: 'Future', protocol: 'webdav', host: 'dav.invalid', port: 443 }

test('each tab lists only its own profiles; saves and deletes keep every other profile, including unknown protocols', async () => {
  const f = fixture({ extra: [ftp, ftps, webdav] })
  const others = (settings) => settings.connections.filter(item => item.protocol !== 'sftp')
  try {
    await f.show()
    assert.deepEqual(f.tabs.value.map(tab => tab.id), ['sftp', 'ftp', 'ftps'])
    assert.deepEqual(f.profiles.value.map(item => item.id), ['existing'])
    assert.equal(f.unsupportedProfileCount.value, 1)
    const before = others({ connections: f.saved.at(-1)?.connections || normalizeSettings({ connections: [ftp, ftps, webdav] }).connections })
    f.draft.name = 'Renamed'
    await f.save()
    assert.deepEqual(others(f.saved.at(-1)), before)
    f.selectTab('ftp')
    assert.equal(f.activeTab.value, 'ftp')
    assert.deepEqual(f.profiles.value.map(item => item.id), ['router'])
    f.selectTab('ftps')
    assert.deepEqual(f.profiles.value.map(item => item.id), ['nas'])
    assert.equal(f.draft.port, 990)
    f.newProfile()
    assert.equal(f.draft.protocol, 'ftps')
    assert.equal(f.draft.port, 21)
    assert.equal('privateKeyPath' in f.draft, false, 'no SFTP fields leak into an FTPS profile')
    Object.assign(f.draft, { name: 'Added', host: 'added.invalid', username: 'fixture' })
    await f.save()
    const added = f.saved.at(-1).connections.find(item => item.id === 'new-stable-id')
    assert.equal(added.protocol, 'ftps')
    assert.equal(added.ftpTls, 'explicit')
    assert.deepEqual(f.saved.at(-1).connections.find(item => item.id === 'dav'), { ...webdav })
    await f.remove()
    assert.deepEqual(f.saved.at(-1).connections.map(item => item.id).sort(), ['dav', 'existing', 'nas', 'router'])
  } finally { f.stop() }
})

test('tabs follow capabilities and support arrow, Home and End keys', async () => {
  const sftpOnly = fixture({ protocols: ['sftp'] })
  try {
    await sftpOnly.show()
    assert.deepEqual(sftpOnly.tabs.value.map(tab => tab.id), ['sftp'])
    sftpOnly.selectTab('ftp')
    assert.equal(sftpOnly.activeTab.value, 'sftp')
  } finally { sftpOnly.stop() }
  const f = fixture({ extra: [ftp, ftps] })
  try {
    await f.show()
    const key = (name) => f.tabKeydown({ key: name, preventDefault() {} })
    key('ArrowRight'); assert.equal(f.activeTab.value, 'ftp')
    key('ArrowRight'); assert.equal(f.activeTab.value, 'ftps')
    key('ArrowRight'); assert.equal(f.activeTab.value, 'sftp')
    key('ArrowLeft'); assert.equal(f.activeTab.value, 'ftps')
    key('Home'); assert.equal(f.activeTab.value, 'sftp')
    key('End'); assert.equal(f.activeTab.value, 'ftps')
  } finally { f.stop() }
})

test('secrets are cleared on tab and profile switches; unsaved edits ask before they are discarded', async () => {
  const f = fixture({ extra: [ftp] })
  try {
    await f.show()
    f.password.value = 'typed-secret'
    f.selectTab('ftp')
    assert.equal(f.password.value, '')
    assert.equal(f.activeTab.value, 'ftp')
    f.password.value = 'typed-secret'
    f.newProfile()
    assert.equal(f.password.value, '')
    f.draft.name = 'Unsaved'
    f.selectTab('sftp')
    assert.equal(f.dialog.value.kind, 'discard')
    assert.equal(f.activeTab.value, 'ftp')
    f.cancelDialog()
    assert.equal(f.draft.name, 'Unsaved')
    f.close()
    assert.equal(f.dialog.value.kind, 'discard')
    assert.equal(f.events.some(([name]) => name === 'close'), false)
    f.cancelDialog()
    f.selectTab('sftp')
    f.discardAndProceed()
    assert.equal(f.activeTab.value, 'sftp')
    assert.equal(f.draft.id, 'existing')
    assert.equal(f.dirty.value, false)
  } finally { f.stop() }
})

test('FTPS suggests 21 or 990 for a new profile only until the port is typed, and never changes a saved port', async () => {
  const f = fixture({ extra: [{ ...ftps, port: 2121, ftpTls: 'explicit' }] })
  try {
    await f.show(); f.selectTab('ftps')
    f.draft.ftpTls = 'implicit'; await nextTick()
    assert.equal(f.draft.port, 2121, 'a saved profile keeps its port')
    f.newProfile()
    assert.equal(f.dialog.value.kind, 'discard')
    f.discardAndProceed(); await nextTick()
    assert.equal(f.draft.port, 21)
    f.draft.ftpTls = 'implicit'; await nextTick()
    assert.equal(f.draft.port, 990)
    f.draft.ftpTls = 'explicit'; await nextTick()
    assert.equal(f.draft.port, 21)
    f.draft.port = 2200; f.portTouched.value = true
    f.draft.ftpTls = 'implicit'; await nextTick()
    assert.equal(f.draft.port, 2200)
  } finally { f.stop() }
})

test('plain FTP asks for consent before the first connect and saves it only after agreement', async () => {
  const f = fixture({ extra: [{ ...ftp, plaintextAcknowledged: false }], response: { ok: true, connectionId: 'router', providerId: 'ftp:router' } })
  try {
    await f.show(); f.selectTab('ftp')
    f.password.value = 'ftp-secret'
    await f.connect()
    assert.equal(f.dialog.value.kind, 'plaintext')
    assert.equal(f.requests.length, 0, 'nothing is sent before consent')
    f.cancelDialog()
    assert.equal(f.requests.length, 0)
    await f.connect({ acknowledgePlaintext: true })
    assert.equal(f.saved.at(-1).connections.find(item => item.id === 'router').plaintextAcknowledged, true)
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0][0].protocol, 'ftp')
    assert.equal(f.requests[0][1].password, 'ftp-secret')
    assert.equal(JSON.stringify(f.saved).includes('ftp-secret'), false)
    const connected = f.events.find(([name]) => name === 'connected')[1]
    assert.equal(connected.providerId, 'ftp:router')
    assert.equal(connected.targetPanel, 'left')
  } finally { f.stop() }
})

test('Anonymous FTP defaults the user name and sends no typed password', async () => {
  const f = fixture({ extra: [ftp] })
  try {
    await f.show(); f.selectTab('ftp'); f.newProfile()
    Object.assign(f.draft, { name: 'Mirror', host: 'mirror.invalid', username: '' })
    f.draft.authType = 'anonymous'; await nextTick()
    assert.equal(f.draft.username, 'anonymous')
    await f.connect({ acknowledgePlaintext: true })
    assert.equal(f.requests[0][1].password, '')
    const saved = f.saved.at(-1).connections.find(item => item.name === 'Mirror')
    assert.equal(saved.authType, 'anonymous')
    assert.equal(saved.savePassword, false)
  } finally { f.stop() }
})

test('FTPS certificate trust is explicit: shown, saved as a pin and retried only after consent', async () => {
  const certificate = { endpoint: 'nas.invalid:990', sha256: 'cd'.repeat(32), subject: 'CN=nas', issuer: 'CN=nas', notBefore: '2026-01-01T00:00:00+00:00',
    notAfter: '2027-01-01T00:00:00+00:00', dnsNames: ['nas.invalid'], ipAddresses: [], reason: 'untrusted' }
  const f = fixture({ extra: [{ ...ftps, tlsTrustedCertificate: '' }], response: [
    { ok: false, error: { code: 'ETLS_CERTIFICATE_UNTRUSTED', message: 'The FTPS server certificate is not trusted' }, certificate },
    { ok: true, connectionId: 'nas', providerId: 'ftps:nas' },
  ] })
  try {
    await f.show(); f.selectTab('ftps')
    await f.connect()
    assert.equal(f.dialog.value.kind, 'certificate')
    assert.equal(f.dialog.value.certificate.sha256, certificate.sha256)
    assert.equal(f.requests.length, 1, 'no hidden retry')
    assert.equal(f.saved.at(-1)?.connections.find(item => item.id === 'nas').tlsTrustedCertificate || '', '')
    await f.connect({ certificate: f.dialog.value.certificate })
    assert.equal(f.saved.at(-1).connections.find(item => item.id === 'nas').tlsTrustedCertificate, certificate.sha256)
    assert.equal(f.requests.length, 2)
    assert.equal(f.events.some(([name]) => name === 'connected'), true)
  } finally { f.stop() }
})

test('a changed FTPS certificate blocks with both fingerprints and never replaces the pin', async () => {
  const pinned = 'ab'.repeat(32), presented = 'ef'.repeat(32)
  const f = fixture({ extra: [ftps], response: { ok: false, error: { code: 'ETLS_CERTIFICATE_CHANGED', message: 'changed' },
    certificate: { endpoint: 'nas.invalid:990', sha256: presented, pinnedSha256: pinned, reason: 'changed', subject: '', issuer: '', dnsNames: [], ipAddresses: [] } } })
  try {
    await f.show(); f.selectTab('ftps')
    await f.connect()
    assert.equal(f.dialog.value.kind, 'certificateChanged')
    assert.equal(f.dialog.value.certificate.pinnedSha256, pinned)
    assert.equal(f.dialog.value.certificate.sha256, presented)
    assert.equal(f.requests.length, 1)
    assert.equal(f.saved.at(-1).connections.find(item => item.id === 'nas').tlsTrustedCertificate, pinned)
    f.cancelDialog()
    await f.removeTrustedCertificate()
    assert.equal(f.saved.at(-1).connections.find(item => item.id === 'nas').tlsTrustedCertificate, '')
    assert.equal(f.requests.length, 1, 'removing the pin does not connect')
  } finally { f.stop() }
})

test('the dialog source keeps ARIA tabs, the consent text and credential storage gated by capability', async () => {
  const vue = await fs.readFile(new URL('../src/components/RemoteConnectionsModal.vue', import.meta.url), 'utf8')
  assert.match(vue, /class="nav nav-tabs[^"]*" role="tablist"/)
  assert.match(vue, /role="tab"[\s\S]*?:aria-selected=/)
  assert.match(vue, /role="tabpanel"/)
  assert.doesNotMatch(vue, /data-bs-toggle="tab"/, 'Vue owns the active tab')
  assert.match(vue, /This connection is not encrypted\. Your password and files may be visible to others on the network\./)
  assert.match(vue, />Connect without encryption</)
  assert.match(vue, /v-if="capabilities\.credentialStore" class="form-check mt-2"><input id="remote-save-password"/)
  assert.match(vue, /class="col-12 col-sm-4"/, 'list and form stack in narrow windows')
})

test('connection state follows status requests and events; Disconnect and Reconnect route by protocol', async () => {
  const f = fixture({ extra: [ftps], status: 'connected' })
  try {
    f.onMountedHooks[0]()
    await f.show(); f.selectTab('ftps'); await nextTick(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.connectionState.value, 'connected')
    await f.disconnect()
    assert.deepEqual(f.disconnected.at(-1), ['nas', 'ftps'])
    assert.equal(f.connectionState.value, 'disconnected')
    f.statusListeners[0]({ connectionId: 'nas', protocol: 'ftps', providerId: 'ftps:nas', status: 'connected' })
    assert.equal(f.connectionState.value, 'connected')
    // An event for the same id under another protocol is not this profile.
    f.statusListeners[0]({ connectionId: 'nas', protocol: 'sftp', providerId: 'sftp:nas', status: 'disconnected' })
    assert.equal(f.connectionState.value, 'connected')
  } finally { f.stop() }
})

test('Cancel connection stays available for the whole FTP connect and stops it on the backend', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ extra: [ftp], connectGate: gate, response: { ok: true, connectionId: 'router', providerId: 'ftp:router' } })
  try {
    await f.show(); f.selectTab('ftp')
    const pending = f.connect()
    await new Promise(resolve => setImmediate(resolve))
    // The handshake is running: no permission wait, yet Cancel is offered.
    assert.equal(f.connecting.value, true)
    f.cancelConnection()
    // The dialog is usable at once, without waiting for the server.
    await pending
    assert.equal(f.busy.value, false)
    assert.equal(f.connecting.value, false)
    assert.deepEqual(f.cancelled, [['ftp', 'new-stable-id']])
    release(); await new Promise(resolve => setImmediate(resolve))
    // The backend closes a connection that won the race; the UI opens nothing.
    assert.equal(f.events.some(([name]) => name === 'connected'), false)
    assert.deepEqual(f.disconnected, [])
  } finally { f.stop() }
})

test('Cancel stops an SFTP connect on the backend; the dialog never disconnects by id itself', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ connectGate: gate, response: { ok: true, connectionId: 'existing', providerId: 'sftp:existing' } })
  try {
    await f.show()
    const pending = f.connect()
    await new Promise(resolve => setImmediate(resolve))
    f.cancelConnection()
    await pending
    assert.equal(f.busy.value, false)
    assert.deepEqual(f.cancelled, [['sftp', 'new-stable-id']])
    release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.events.some(([name]) => name === 'connected'), false)
    assert.deepEqual(f.disconnected, [])
  } finally { f.stop() }
})

test('without backend cancellation a late result is disconnected, but never after a newer attempt started', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve))
  // The native app: no cancel event, so the dialog closes the late connection itself.
  {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const f = fixture({ connectGate: gate, cancelSupported: false, response: { ok: true, connectionId: 'existing', providerId: 'sftp:existing' } })
    try {
      await f.show()
      const pending = f.connect(); await settle()
      f.cancelConnection(); await pending
      release(); await settle(); await settle()
      assert.deepEqual(f.disconnected, [['existing', 'sftp']])
    } finally { f.stop() }
  }
  // Cancel the first attempt, start a second at once, then the first answers
  // late: disconnecting by id would close the second connection.
  {
    let release, serial = 0
    const gate = new Promise(resolve => { release = resolve })
    const f = fixture({ connectGate: gate, cancelSupported: false, uuid: () => `id-${++serial}`,
      response: [{ ok: true, connectionId: 'existing', providerId: 'sftp:existing' }, { ok: true, connectionId: 'existing', providerId: 'sftp:existing' }] })
    try {
      await f.show()
      const first = f.connect(); await settle()
      f.cancelConnection(); await first
      const second = f.connect(); await settle()
      release(); await second; await settle(); await settle()
      assert.deepEqual(f.disconnected, [])
      assert.equal(f.events.filter(([name]) => name === 'connected').length, 1)
      assert.equal(f.connectionState.value, 'connected')
    } finally { f.stop() }
  }
})

test('the dialog source shows Cancel connection for the whole connect, not only the permission wait', async () => {
  const vue = await fs.readFile(new URL('../src/components/RemoteConnectionsModal.vue', import.meta.url), 'utf8')
  assert.match(vue, /<button v-if="connecting" class="btn btn-sm btn-neutral" type="button" @click="cancelConnection">Cancel connection<\/button>/)
})

test('the unsaved-changes prompt can save before switching', async () => {
  const f = fixture({ extra: [ftp] })
  try {
    await f.show()
    f.draft.name = 'Renamed before switching'
    f.selectTab('ftp')
    assert.equal(f.dialog.value.kind, 'discard')
    await f.saveAndProceed()
    assert.equal(f.activeTab.value, 'ftp')
    assert.equal(f.saved.at(-1).connections.find(item => item.id === 'existing').name, 'Renamed before switching')
  } finally { f.stop() }
})

test('a future protocol is one registry entry: its tab, fields and default port need no dialog changes', async () => {
  const webdavTab = Object.freeze({ id: 'webdav', label: 'WebDAV', icon: 'mdi-web', description: 'WebDAV over HTTPS.',
    authTypes: [{ value: 'password', label: 'Password' }], fields: { davPath: '/' }, features: {}, passwordAuth: ['password'],
    pathPlaceholder: '/', defaultPort: () => 443 })
  const f = fixture({ registry: [...CONNECTION_PROTOCOLS, webdavTab], protocols: ['sftp', 'ftp', 'ftps', 'webdav'], extra: [webdav] })
  try {
    await f.show()
    assert.deepEqual(f.tabs.value.map(tab => tab.id), ['sftp', 'ftp', 'ftps', 'webdav'])
    f.selectTab('webdav')
    assert.deepEqual(f.profiles.value.map(item => item.id), ['dav'])
    f.newProfile()
    assert.equal(f.draft.protocol, 'webdav')
    assert.equal(f.draft.port, 443)
    assert.equal(f.draft.davPath, '/')
    assert.equal('ftpTls' in f.draft || 'privateKeyPath' in f.draft, false)
  } finally { f.stop() }
  // Without the capability the profile stays saved but gets no tab.
  const hidden = fixture({ extra: [webdav] })
  try {
    await hidden.show()
    assert.equal(hidden.tabs.value.some(tab => tab.id === 'webdav'), false)
    assert.equal(hidden.unsupportedProfileCount.value, 1)
  } finally { hidden.stop() }
})
