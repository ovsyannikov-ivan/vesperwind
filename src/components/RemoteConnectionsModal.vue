<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { connectionsApi } from '../api/connections.js'
import { useSettings } from '../composables/useSettings.js'
import { CERTIFICATE_REASONS, CONNECTION_PROTOCOLS, defaultConnectionPort, emptyConnectionProfile, profileFields, protocolDefinition } from './remoteConnectionProtocols.js'

const props = defineProps({ open: Boolean, activePanel: { type: String, default: 'left' } })
const emit = defineEmits(['close', 'connected'])
const { settings, loadSettings, saveSettings } = useSettings()
const modalElement = ref(null)
// Vue owns the active tab; Bootstrap only styles the tabs.
const activeTab = ref('sftp')
const selectedId = ref('')
const password = ref(''), keyPassphrase = ref('')
const busy = ref(false), loading = ref(false)
const permissionPending = ref(false)
let permissionController
const error = ref(''), warning = ref(''), configError = ref(''), credentialError = ref('')
const hostKey = ref(null), hostKeyErrorCode = ref('')
const authNeeds = ref('')
// A confirmation shown in place of the form: `plaintext`, `certificate`,
// `certificateChanged` or `discard`. Nothing it guards happens without it.
const dialog = ref(null)
const capabilities = ref({ credentialStore: false, sshConfig: false, auto: true, agent: true, protocols: ['sftp'] })
const configHosts = ref([])
const credentials = ref({ password: false, keyPassphrase: false })
const portTouched = ref(false)
let modal, selectionGeneration = 0, showGeneration = 0
const draft = reactive(emptyConnectionProfile('sftp'))
const baseline = ref('')
// Every save and delete writes the complete list: profiles of other tabs and
// preserved profiles of unknown protocols stay untouched.
const allProfiles = computed(() => settings.value.connections || [])
const tabs = computed(() => CONNECTION_PROTOCOLS.filter(item => (capabilities.value.protocols || ['sftp']).includes(item.id)))
const definition = computed(() => protocolDefinition(activeTab.value))
const features = computed(() => definition.value?.features || {})
const profiles = computed(() => allProfiles.value.filter(item => item.protocol === activeTab.value))
const unsupportedProfileCount = computed(() => allProfiles.value.filter(item => !tabs.value.some(tab => tab.id === item.protocol)).length)
const selected = computed(() => profiles.value.find(item => item.id === selectedId.value) || null)
const configIdentity = computed(() => configHosts.value.find(host => host.alias === draft.sshConfigHost)?.identities[0] || '')
const passwordVisible = computed(() => (definition.value?.passwordAuth || []).includes(draft.authType))
const passphraseVisible = computed(() => features.value.keyPassphrase && (draft.authType === 'privateKey' || (draft.authType === 'auto' && (authNeeds.value === 'keyPassphrase' || credentials.value.keyPassphrase))))
const editable = () => JSON.stringify(profileFields(draft.protocol).map(field => draft[field] ?? null))
const dirty = computed(() => Boolean(baseline.value) && editable() !== baseline.value)
const clearSecrets = () => { password.value = ''; keyPassphrase.value = '' }
const clearConnectionError = () => { error.value = ''; warning.value = ''; authNeeds.value = ''; hostKey.value = null; hostKeyErrorCode.value = '' }
const fill = (profile = null, protocol = activeTab.value) => {
  // A profile has exactly its protocol's fields; nothing leaks between tabs.
  for (const key of Object.keys(draft)) delete draft[key]
  Object.assign(draft, emptyConnectionProfile(protocol), profile || {})
  portTouched.value = false
  baseline.value = editable()
}
const refreshCredentials = async () => {
  const generation = ++selectionGeneration, id = draft.id
  credentials.value = { password: false, keyPassphrase: false }; credentialError.value = ''
  if (!id || !capabilities.value.credentialStore || !profiles.value.some(profile => profile.id === id)) return
  const response = await connectionsApi.credentialStatus(id)
  if (generation !== selectionGeneration || draft.id !== id) return
  if (response.ok) credentials.value = response.credentials
  else credentialError.value = response.error.message
}
const focusDialog = async () => { await nextTick(); modalElement.value?.querySelector('[data-dialog-focus]')?.focus() }
// Unsaved edits are never dropped silently: switching asks first.
const guard = (proceed) => {
  if (!dirty.value) { proceed(); return }
  dialog.value = { kind: 'discard', proceed }
  void focusDialog()
}
const discardAndProceed = () => { const proceed = dialog.value?.proceed; dialog.value = null; proceed?.() }
const showProfile = (profile) => { selectedId.value = profile?.id || ''; fill(profile); clearSecrets(); clearConnectionError(); void refreshCredentials() }
const select = (profile) => guard(() => showProfile(profile))
const newProfile = () => guard(() => showProfile(null))
const showTab = (protocol) => {
  activeTab.value = protocol
  // Secrets and errors never carry over to another connection type.
  showProfile(profiles.value[0] || null)
}
const selectTab = (protocol) => {
  if (protocol === activeTab.value || busy.value || dialog.value || !tabs.value.some(tab => tab.id === protocol)) return
  guard(() => showTab(protocol))
}
const tabKeydown = (event) => {
  const ids = tabs.value.map(tab => tab.id)
  const index = ids.indexOf(activeTab.value)
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: ids.length - 1 }[event.key]
  if (next === undefined) return
  event.preventDefault()
  const target = ids[(next + ids.length) % ids.length]
  selectTab(target)
  void nextTick(() => modalElement.value?.querySelector(`#remote-tab-${activeTab.value}`)?.focus())
}
const selectConfig = (host) => guard(() => {
  const existing = profiles.value.find(profile => profile.sshConfigHost === host.alias)
  selectedId.value = existing?.id || ''
  fill({ ...existing, id: existing?.id || crypto.randomUUID(), name: existing?.name || host.alias,
    host: host.host, port: host.port, username: host.username, authType: 'auto', sshConfigHost: host.alias,
    privateKeyPath: existing?.privateKeyPath || '' }, 'sftp')
  clearSecrets(); clearConnectionError(); void refreshCredentials()
  if (host.unsupported) error.value = host.unsupported
})
const validateDraft = () => {
  if (!String(draft.name).trim()) throw Error('Connection name is required')
  if (!String(draft.host).trim()) throw Error('Host is required')
  if (!String(draft.username).trim() && draft.authType !== 'anonymous') throw Error('Username is required')
  if (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535) throw Error('Port must be between 1 and 65535')
  if (draft.authType === 'privateKey' && !String(draft.privateKeyPath).trim()) throw Error('Private key path is required')
  if (draft.initialPath && (!String(draft.initialPath).startsWith('/') || String(draft.initialPath).includes('\\'))) throw Error('Initial remote path must be an absolute POSIX path')
}
const normalizedDraft = () => {
  validateDraft()
  const profile = Object.fromEntries(profileFields(draft.protocol).map(field => [field, draft[field]]))
  Object.assign(profile, {
    id: draft.id || crypto.randomUUID(), name: String(draft.name).trim(), host: String(draft.host).trim(), port: Number(draft.port),
    username: String(draft.username).trim() || (draft.authType === 'anonymous' ? 'anonymous' : ''), initialPath: String(draft.initialPath).trim(),
    // Kept as saved when this runtime has no credential store (the native app may use it).
    savePassword: passwordVisible.value && draft.savePassword,
  })
  // Trust belongs to an endpoint: a changed endpoint must be confirmed again.
  const old = selected.value
  const endpointChanged = old && (old.host !== profile.host || old.port !== profile.port)
  if (profile.protocol === 'sftp') {
    profile.privateKeyPath = String(draft.privateKeyPath).trim()
    profile.saveKeyPassphrase = ['auto', 'privateKey'].includes(draft.authType) && draft.saveKeyPassphrase
    if (endpointChanged) profile.trustedFingerprint = ''
  }
  if (profile.protocol === 'ftp' && endpointChanged) profile.plaintextAcknowledged = false
  if (profile.protocol === 'ftps' && (endpointChanged || (old && old.ftpTls !== profile.ftpTls))) profile.tlsTrustedCertificate = ''
  return profile
}
const saveProfile = async (profile = normalizedDraft()) => {
  // An edited profile keeps its place in the list; a new one is added last.
  const exists = allProfiles.value.some(item => item.id === profile.id)
  const connections = exists ? allProfiles.value.map(item => item.id === profile.id ? profile : item) : [...allProfiles.value, profile]
  const response = await saveSettings({ ...settings.value, connections })
  if (!response?.ok) throw Error(response?.error?.message || 'Unable to save connection')
  selectedId.value = profile.id
  const saved = response.settings.connections.find(item => item.id === profile.id)
  fill(saved, saved.protocol); await refreshCredentials()
  return saved
}
const save = async () => {
  busy.value = true; clearConnectionError()
  try { await saveProfile() } catch (cause) { error.value = cause.message } finally { busy.value = false }
}
const remove = async () => {
  if (!selected.value) return
  busy.value = true; clearConnectionError()
  try {
    const response = await saveSettings({ ...settings.value, connections: allProfiles.value.filter(item => item.id !== selected.value.id) })
    if (!response?.ok) throw Error(response?.error?.message || 'Unable to delete connection')
    showProfile(null)
  } catch (cause) { error.value = cause.message } finally { busy.value = false }
}
const forget = async (kind) => {
  busy.value = true; clearConnectionError()
  try {
    const response = await connectionsApi.forgetCredential(draft.id, kind)
    if (!response.ok) throw Error(response.error.message)
    if (kind === 'password') { draft.savePassword = false; password.value = '' }
    else { draft.saveKeyPassphrase = false; keyPassphrase.value = '' }
    await saveProfile()
  } catch (cause) { error.value = cause.message; await refreshCredentials() } finally { busy.value = false }
}
// A deliberate step of its own: the pin is never replaced automatically.
const removeTrustedCertificate = async () => {
  busy.value = true; clearConnectionError()
  try { await saveProfile({ ...normalizedDraft(), tlsTrustedCertificate: '' }) } catch (cause) { error.value = cause.message } finally { busy.value = false }
}
const certificateFailure = (code) => ['ETLS_CERTIFICATE_UNTRUSTED', 'ETLS_CERTIFICATE_HOSTNAME', 'ETLS_CERTIFICATE_EXPIRED'].includes(code)
/**
 * `trust`: the SSH host key shown in the alert. `acknowledgePlaintext`: the
 * consent of the plain-FTP dialog. `certificate`: the FTPS certificate the
 * person chose to trust. Each is saved first, as its own settings change,
 * after any endpoint edit, so it applies to exactly the endpoint it was
 * confirmed for.
 */
const connect = async ({ trust = false, acknowledgePlaintext = false, certificate = null } = {}) => {
  const trustedFingerprint = trust ? hostKey.value?.fingerprint : ''
  dialog.value = null
  busy.value = true; clearConnectionError()
  try {
    if (draft.protocol === 'sftp' && draft.sshConfigHost) {
      const response = await connectionsApi.resolveSshHost(draft.sshConfigHost)
      if (!response.ok) throw Error(response.error.message)
      if (response.host.unsupported) throw Error(response.host.unsupported)
      Object.assign(draft, { host: response.host.host, port: response.host.port, username: response.host.username })
    }
    let profile = normalizedDraft()
    if (profile.protocol === 'ftp' && !profile.plaintextAcknowledged && !acknowledgePlaintext) {
      // Asked before the first connect; nothing is sent until the person agrees.
      dialog.value = { kind: 'plaintext' }
      void focusDialog()
      return
    }
    if (trustedFingerprint) profile.trustedFingerprint = trustedFingerprint
    profile = await saveProfile(profile)
    if (acknowledgePlaintext && profile.protocol === 'ftp') profile = await saveProfile({ ...profile, plaintextAcknowledged: true })
    if (certificate && profile.protocol === 'ftps') {
      if (certificate.endpoint !== `${profile.host}:${profile.port}`) throw Error('The connection changed; connect again to review its certificate')
      profile = await saveProfile({ ...profile, tlsTrustedCertificate: certificate.sha256 })
    }
    permissionController = new AbortController()
    const response = await connectionsApi.connect(profile, { password: password.value, keyPassphrase: keyPassphrase.value }, {
      signal: permissionController.signal, onPermissionWait: value => { permissionPending.value = value },
    })
    if (!response?.ok) {
      const code = response?.error?.code || ''
      if (code === 'ECANCELLED') return
      if (code === 'ETLS_CERTIFICATE_CHANGED' && response.certificate) {
        dialog.value = { kind: 'certificateChanged', certificate: response.certificate }
        void focusDialog()
        return
      }
      if (certificateFailure(code) && response.certificate) {
        dialog.value = { kind: 'certificate', certificate: response.certificate }
        void focusDialog()
        return
      }
      hostKey.value = response.hostKey || response.error?.hostKey || null
      hostKeyErrorCode.value = code
      authNeeds.value = response.auth?.needs || ''
      error.value = response.error.message
      return
    }
    clearSecrets(); await refreshCredentials()
    emit('connected', { ...response, profile, targetPanel: props.activePanel })
    if (response.credentialWarning) warning.value = `Connected, but the credential could not be saved securely. ${response.credentialWarning.message}`
    else emit('close')
  } catch (cause) { error.value = cause.message || 'Unable to connect' } finally {
    busy.value = false; permissionPending.value = false; permissionController = null
    await nextTick()
    const id = authNeeds.value === 'keyPassphrase' ? 'remote-passphrase' : authNeeds.value === 'password' ? 'remote-password' : null
    if (id && !dialog.value) modalElement.value?.querySelector(`#${id}`)?.focus()
  }
}
const cancelDialog = () => { dialog.value = null }
const show = async () => {
  const generation = ++showGeneration
  loading.value = true; modal?.show(); clearConnectionError(); configError.value = ''; dialog.value = null
  try {
    const [loaded, supported] = await Promise.all([loadSettings({ force: true }), connectionsApi.capabilities()])
    if (generation !== showGeneration || !props.open) return
    if (!loaded.ok) throw Error(loaded.error.message)
    if (!supported.ok) throw Error(supported.error.message)
    capabilities.value = { ...supported.capabilities, protocols: supported.capabilities.protocols || ['sftp'] }
    showTab(tabs.value.some(tab => tab.id === activeTab.value) ? activeTab.value : tabs.value[0]?.id || 'sftp')
    configHosts.value = []
    if (capabilities.value.sshConfig) {
      const config = await connectionsApi.sshConfigHosts()
      if (generation !== showGeneration || !props.open) return
      if (config.ok) configHosts.value = config.hosts
      else configError.value = config.error.message
    }
  } catch (cause) { error.value = cause.message } finally { if (generation === showGeneration) loading.value = false }
}
const finishClose = () => { baseline.value = ''; dialog.value = null; clearSecrets(); emit('close') }
const close = () => { if (!busy.value) guard(finishClose) }
const handleHide = (event) => {
  if (busy.value) { event.preventDefault(); return }
  // Escape with unsaved edits asks first instead of closing; on that
  // question it means "keep editing".
  if (props.open && dirty.value) {
    event.preventDefault()
    if (dialog.value?.kind === 'discard') cancelDialog()
    else guard(finishClose)
  }
}
const handleHidden = () => { clearSecrets(); if (props.open) emit('close') }
watch(() => props.open, value => { if (value) show(); else { showGeneration++; selectionGeneration++; clearSecrets(); dialog.value = null; modal?.hide() } })
watch(() => draft.authType, (value, previous) => {
  if (previous === undefined) return
  clearSecrets(); authNeeds.value = ''
  if (value === 'anonymous' && !String(draft.username).trim()) draft.username = 'anonymous'
  if (value === 'anonymous') draft.savePassword = false
})
// Explicit ↔ implicit TLS suggests 21 ↔ 990, only for a new profile whose
// port the person has not typed; a saved profile keeps its port.
watch(() => draft.ftpTls, (value, previous) => {
  if (!value || !previous || value === previous || selected.value || portTouched.value) return
  if (Number(draft.port) === defaultConnectionPort('ftps', previous)) draft.port = defaultConnectionPort('ftps', value)
})
const certificateValidity = (certificate) => [certificate.notBefore, certificate.notAfter].map(value => value ? new Date(value).toLocaleString() : 'unknown').join(' – ')
const certificateNames = (certificate) => [...(certificate.dnsNames || []), ...(certificate.ipAddresses || [])].join(', ') || 'none'
onMounted(() => {
  modal = new Modal(modalElement.value, { backdrop: 'static' })
  modalElement.value.addEventListener('hide.bs.modal', handleHide)
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)
  if (props.open) show()
})
onBeforeUnmount(() => {
  permissionController?.abort()
  showGeneration++; selectionGeneration++; clearSecrets()
  modalElement.value?.removeEventListener('hide.bs.modal', handleHide)
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  modal?.dispose(); modal = null
})
</script>

<template>
  <Teleport to="body">
    <div ref="modalElement" class="modal fade" tabindex="-1" aria-labelledby="remote-connections-title" aria-describedby="remote-connections-description">
      <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="remote-connections-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi mdi-server-network" aria-hidden="true" />Remote Connections</h1>
            <button class="btn-close" type="button" aria-label="Close" :disabled="busy" @click="close" />
          </div>
          <div class="modal-body">
            <div class="nav nav-tabs remote-connections-tabs mb-3" role="tablist" aria-label="Connection type">
              <button v-for="tab in tabs" :id="`remote-tab-${tab.id}`" :key="tab.id" class="nav-link d-flex align-items-center gap-1" :class="{ active: activeTab === tab.id }" type="button" role="tab"
                :aria-selected="activeTab === tab.id ? 'true' : 'false'" aria-controls="remote-connections-panel" :tabindex="activeTab === tab.id ? 0 : -1" :disabled="busy || Boolean(dialog) || (loading && activeTab !== tab.id)"
                @click="selectTab(tab.id)" @keydown="tabKeydown"><i class="mdi" :class="tab.icon" aria-hidden="true" />{{ tab.label }}</button>
            </div>
            <div id="remote-connections-panel" role="tabpanel" :aria-labelledby="`remote-tab-${activeTab}`">
              <p id="remote-connections-description" class="text-body-secondary small">{{ definition?.description }}</p>
              <div v-if="loading" class="d-flex align-items-center gap-2 text-body-secondary mb-3" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true" />Loading connections…</div>

              <section v-if="dialog" class="remote-connections-dialog" role="alertdialog" aria-modal="false" aria-labelledby="remote-dialog-title" aria-describedby="remote-dialog-body">
                <template v-if="dialog.kind === 'plaintext'">
                  <h2 id="remote-dialog-title" class="h6 d-flex align-items-center gap-2"><i class="mdi mdi-lock-alert text-warning" aria-hidden="true" />Connect without encryption?</h2>
                  <p id="remote-dialog-body" class="mb-0">This connection is not encrypted. Your password and files may be visible to others on the network.</p>
                </template>
                <template v-else-if="dialog.kind === 'certificate' || dialog.kind === 'certificateChanged'">
                  <h2 id="remote-dialog-title" class="h6 d-flex align-items-center gap-2">
                    <i class="mdi" :class="dialog.kind === 'certificateChanged' ? 'mdi-shield-alert text-danger' : 'mdi-certificate-outline text-warning'" aria-hidden="true" />
                    {{ dialog.kind === 'certificateChanged' ? 'Server certificate changed — connection blocked' : 'Untrusted server certificate' }}
                  </h2>
                  <div id="remote-dialog-body">
                    <div class="alert py-2 small" :class="dialog.kind === 'certificateChanged' ? 'alert-danger' : 'alert-warning'" role="status">
                      {{ CERTIFICATE_REASONS[dialog.certificate.reason] || CERTIFICATE_REASONS.invalid }}
                      <template v-if="dialog.kind === 'certificateChanged'"> This can mean that someone is intercepting the connection. Verify the new fingerprint with the server administrator. To trust it, remove the trusted certificate in the connection settings, then connect again.</template>
                    </div>
                    <dl class="row small mb-2 remote-certificate-details">
                      <dt class="col-sm-3">Server</dt><dd class="col-sm-9 text-break">{{ dialog.certificate.endpoint }}</dd>
                      <template v-if="dialog.kind === 'certificateChanged'">
                        <dt class="col-sm-3">Trusted SHA-256</dt><dd class="col-sm-9"><code class="text-break">{{ dialog.certificate.pinnedSha256 }}</code></dd>
                        <dt class="col-sm-3">Presented SHA-256</dt><dd class="col-sm-9"><code class="text-break">{{ dialog.certificate.sha256 }}</code></dd>
                      </template>
                      <template v-else><dt class="col-sm-3">SHA-256</dt><dd class="col-sm-9"><code class="text-break">{{ dialog.certificate.sha256 }}</code></dd></template>
                      <dt class="col-sm-3">Subject</dt><dd class="col-sm-9 text-break">{{ dialog.certificate.subject || 'unknown' }}</dd>
                      <dt class="col-sm-3">Issuer</dt><dd class="col-sm-9 text-break">{{ dialog.certificate.issuer || 'unknown' }}</dd>
                      <dt class="col-sm-3">Valid</dt><dd class="col-sm-9">{{ certificateValidity(dialog.certificate) }}</dd>
                      <dt class="col-sm-3">Names (SAN)</dt><dd class="col-sm-9 text-break">{{ certificateNames(dialog.certificate) }}</dd>
                    </dl>
                    <p v-if="dialog.kind === 'certificate'" class="small mb-0">Trusting saves this exact certificate for this connection. Vesperwind will then accept it without checking who issued it, the host name or its expiry date, and will refuse any other certificate. Trust it only if you have verified the fingerprint.</p>
                  </div>
                </template>
                <template v-else-if="dialog.kind === 'discard'">
                  <h2 id="remote-dialog-title" class="h6 d-flex align-items-center gap-2"><i class="mdi mdi-content-save-alert-outline text-warning" aria-hidden="true" />Discard unsaved changes?</h2>
                  <p id="remote-dialog-body" class="mb-0">The changes to this connection have not been saved.</p>
                </template>
              </section>

              <div v-show="!dialog" class="row g-3">
                <div class="col-12 col-sm-4">
                  <h2 class="h6 mb-2">Saved connections</h2>
                  <div class="list-group remote-connections-list" :class="{ 'mb-2': profiles.length }">
                    <button v-for="profile in profiles" :key="profile.id" class="list-group-item list-group-item-action py-2" :class="{ active: selectedId === profile.id }" type="button" :aria-current="selectedId === profile.id ? 'true' : undefined" :disabled="busy || loading" @click="select(profile)">
                      <strong class="d-block text-truncate">{{ profile.name }}</strong><small class="d-block text-truncate">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</small>
                    </button>
                  </div>
                  <div v-if="!profiles.length" class="text-body-secondary small mb-2">No saved {{ definition?.label }} connections.</div>
                  <div v-if="unsupportedProfileCount && !loading" class="text-body-secondary small mb-2" role="note">{{ unsupportedProfileCount }} saved {{ unsupportedProfileCount === 1 ? 'connection uses a type' : 'connections use types' }} this version does not support. {{ unsupportedProfileCount === 1 ? 'It is' : 'They are' }} kept unchanged.</div>
                  <template v-if="features.sshConfig && capabilities.sshConfig">
                    <h2 class="h6 mt-3 mb-2">SSH config</h2>
                    <div class="list-group mb-2">
                      <button v-for="host in configHosts" :key="host.alias" class="list-group-item list-group-item-action py-2" :class="{ active: draft.sshConfigHost === host.alias }" type="button" :disabled="busy || loading" @click="selectConfig(host)">
                        <span class="d-block text-truncate">{{ host.alias }}</span><small class="d-block text-truncate">{{ host.username }}@{{ host.host }}:{{ host.port }}</small>
                      </button>
                    </div>
                    <div v-if="!configHosts.length && !configError && !loading" class="text-body-secondary small mb-2">No hosts found.</div>
                    <div v-if="configError" class="text-danger small mb-2" role="status">{{ configError }}</div>
                  </template>
                  <button class="btn btn-sm btn-neutral w-100" type="button" :disabled="busy || loading" @click="newProfile"><i class="mdi mdi-plus" aria-hidden="true" /> Add</button>
                </div>
                <form class="col-12 col-sm-8" @submit.prevent="connect()">
                  <fieldset class="border-0 p-0 m-0" :disabled="busy || loading">
                  <legend class="visually-hidden">{{ definition?.label }} connection profile</legend>
                  <div class="row g-2">
                    <div class="col-12"><label class="form-label" for="remote-name">Name</label><input id="remote-name" v-model="draft.name" class="form-control form-control-sm" required></div>
                    <div class="col-8"><label class="form-label" for="remote-host">Host</label><input id="remote-host" v-model="draft.host" class="form-control form-control-sm" required></div>
                    <div class="col-4"><label class="form-label" for="remote-port">Port</label><input id="remote-port" v-model.number="draft.port" class="form-control form-control-sm" type="number" min="1" max="65535" required @input="portTouched = true"></div>
                    <div v-if="features.tls" class="col-12">
                      <label class="form-label" for="remote-tls">Encryption</label>
                      <select id="remote-tls" v-model="draft.ftpTls" class="form-select form-select-sm" aria-describedby="remote-tls-help"><option value="explicit">Explicit TLS (AUTH TLS)</option><option value="implicit">Implicit TLS</option></select>
                      <div id="remote-tls-help" class="form-text">Explicit TLS usually uses port 21, implicit TLS port 990. The connection never falls back to unencrypted FTP.</div>
                    </div>
                    <div class="col-6"><label class="form-label" for="remote-user">Username</label><input id="remote-user" v-model="draft.username" class="form-control form-control-sm" :required="draft.authType !== 'anonymous'"></div>
                    <div class="col-6"><label class="form-label" for="remote-auth">Authentication</label><select id="remote-auth" v-model="draft.authType" class="form-select form-select-sm"><option v-for="option in definition?.authTypes || []" :key="option.value" :value="option.value">{{ option.label }}</option></select></div>
                    <div v-if="draft.authType === 'auto'" class="col-12 form-text">Uses SSH Agent and available local keys, then a saved or supplied password.</div>
                    <div v-if="draft.authType === 'anonymous'" class="col-12 form-text">Anonymous access needs no password; none is sent or saved.</div>
                    <div v-if="draft.sshConfigHost" class="col-12 form-text">SSH config: {{ draft.sshConfigHost }}</div>
                    <div v-if="configIdentity" class="col-12 form-text text-break">Identity: {{ configIdentity }}</div>
                    <div v-if="features.privateKey && draft.authType === 'privateKey'" class="col-12"><label class="form-label" for="remote-key">Private key path</label><input id="remote-key" v-model="draft.privateKeyPath" class="form-control form-control-sm" required></div>
                    <div v-if="passwordVisible" class="col-12">
                      <label class="form-label" for="remote-password">Password{{ draft.authType === 'auto' ? ' (optional)' : '' }}</label>
                      <input id="remote-password" v-model="password" class="form-control form-control-sm" type="password" autocomplete="new-password" :placeholder="credentials.password ? 'Leave empty to use saved password' : ''" />
                      <div v-if="capabilities.credentialStore" class="form-check mt-2"><input id="remote-save-password" v-model="draft.savePassword" class="form-check-input" type="checkbox" /><label class="form-check-label" for="remote-save-password">Save password securely</label></div>
                      <div v-if="credentials.password" class="d-flex flex-wrap align-items-center gap-2 mt-1" role="status" aria-live="polite"><span class="small text-body-secondary">Saved securely in system credential store</span><button class="btn btn-sm toolbar-button toolbar-command" type="button" @click="forget('password')">Forget saved password</button></div>
                    </div>
                    <div v-if="passphraseVisible" class="col-12">
                      <label class="form-label" for="remote-passphrase">Key passphrase (optional)</label><input id="remote-passphrase" v-model="keyPassphrase" class="form-control form-control-sm" type="password" autocomplete="new-password" :placeholder="credentials.keyPassphrase ? 'Leave empty to use saved passphrase' : ''" />
                      <div v-if="capabilities.credentialStore" class="form-check mt-2"><input id="remote-save-passphrase" v-model="draft.saveKeyPassphrase" class="form-check-input" type="checkbox" /><label class="form-check-label" for="remote-save-passphrase">Save key passphrase securely</label></div>
                      <div v-if="credentials.keyPassphrase" class="d-flex flex-wrap align-items-center gap-2 mt-1" role="status" aria-live="polite"><span class="small text-body-secondary">Saved securely in system credential store</span><button class="btn btn-sm toolbar-button toolbar-command" type="button" @click="forget('keyPassphrase')">Forget saved passphrase</button></div>
                    </div>
                    <div v-if="passwordVisible || passphraseVisible" class="col-12 form-text">{{ capabilities.credentialStore ? 'Checked credentials are stored after a successful connection. Save stores the profile only.' : 'Secure credential storage is available in the native app. Credentials are used only for this session here.' }}</div>
                    <div v-if="credentialError" class="col-12 text-danger small" role="status">{{ credentialError }}</div>
                    <div class="col-12"><label class="form-label" for="remote-path">Initial remote directory</label><input id="remote-path" v-model="draft.initialPath" class="form-control form-control-sm" :placeholder="definition?.pathPlaceholder"></div>
                    <div v-if="features.tls" class="col-12" role="group" aria-labelledby="remote-certificate-title">
                      <div id="remote-certificate-title" class="form-label mb-1">Server certificate</div>
                      <div v-if="draft.tlsTrustedCertificate" class="small">
                        <div class="text-body-secondary">Trusted by you (pinned). Only this certificate is accepted.</div>
                        <code class="d-block text-break">{{ draft.tlsTrustedCertificate }}</code>
                        <button class="btn btn-sm toolbar-button toolbar-command mt-1" type="button" @click="removeTrustedCertificate">Remove trusted certificate</button>
                      </div>
                      <div v-else class="small text-body-secondary">Verified with your system’s trusted certificates.</div>
                    </div>
                    <div v-if="features.plaintext && draft.plaintextAcknowledged" class="col-12 small text-body-secondary"><i class="mdi mdi-lock-open-alert-outline" aria-hidden="true" /> You agreed to connect to this server without encryption.</div>
                    <div v-if="features.ftpOptions" class="col-12 small text-body-secondary">Data connections: passive mode · File names: UTF-8</div>
                  </div>
                  </fieldset>
                </form>
              </div>
              <div v-if="hostKey && !dialog" class="alert mt-3 mb-0" :class="hostKeyErrorCode === 'EHOSTKEY_CHANGED' ? 'alert-danger' : 'alert-warning'" role="alert">
                <strong>{{ hostKeyErrorCode === 'EHOSTKEY_CHANGED' ? 'SSH host key changed — connection blocked' : 'Unknown SSH host key' }}</strong>
                <div>{{ hostKey.host }}</div>
                <div v-if="hostKey.previousFingerprint" class="small">Expected: <code>{{ hostKey.previousFingerprint }}</code></div>
                <div class="small">Presented: <code>{{ hostKey.fingerprint }}</code></div>
                <p v-if="hostKeyErrorCode === 'EHOSTKEY_CHANGED'" class="small mb-0 mt-2">Verify the server identity before replacing the saved fingerprint.</p>
                <button v-else class="btn btn-sm btn-primary d-block mt-2" type="button" :disabled="busy" @click="connect({ trust: true })">Trust and connect</button>
              </div>
              <div v-if="error && !hostKey && !dialog" class="alert alert-danger mt-3 mb-0" role="alert">{{ error }}</div>
              <div v-if="warning && !dialog" class="alert alert-warning mt-3 mb-0" role="status">{{ warning }}</div>
              <div v-if="permissionPending" class="small text-body-secondary mt-3" role="status">Waiting for macOS local network access. Respond to the system dialog, or enable Vesperwind in System Settings → Privacy &amp; Security → Local Network.</div>
            </div>
          </div>
          <div v-if="dialog" class="modal-footer">
            <template v-if="dialog.kind === 'plaintext'">
              <button class="btn btn-sm btn-neutral" type="button" data-dialog-focus @click="cancelDialog">Cancel</button>
              <button class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="connect({ acknowledgePlaintext: true })">Connect without encryption</button>
            </template>
            <template v-else-if="dialog.kind === 'certificate'">
              <button class="btn btn-sm btn-neutral" type="button" data-dialog-focus @click="cancelDialog">Cancel</button>
              <button class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="connect({ certificate: dialog.certificate })">Trust certificate and connect</button>
            </template>
            <template v-else-if="dialog.kind === 'certificateChanged'">
              <button class="btn btn-sm btn-neutral" type="button" data-dialog-focus @click="cancelDialog">Close</button>
            </template>
            <template v-else>
              <button class="btn btn-sm btn-neutral" type="button" data-dialog-focus @click="cancelDialog">Keep editing</button>
              <button class="btn btn-sm btn-danger" type="button" @click="discardAndProceed">Discard changes</button>
            </template>
          </div>
          <div v-else class="modal-footer">
            <button v-if="selected" class="btn btn-sm btn-danger me-auto" type="button" :disabled="busy" @click="remove">Delete</button>
            <button v-if="permissionPending" class="btn btn-sm btn-neutral" type="button" @click="permissionController?.abort()">Cancel connection</button>
            <button class="btn btn-sm btn-neutral" type="button" :disabled="busy" @click="close">Cancel</button>
            <button class="btn btn-sm btn-neutral" type="button" :disabled="busy || loading" @click="save">Save</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="busy || loading" @click="connect()">{{ busy ? 'Connecting…' : 'Connect' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss">
.remote-connections-tabs {
  .nav-link {
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
  }
}

.remote-certificate-details {
  dt { font-weight: 500; }
  dd { margin-bottom: 0.25rem; }
}
</style>
