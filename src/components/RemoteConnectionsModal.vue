<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { connectionsApi, isSftpProfile } from '../api/connections.js'
import { useSettings } from '../composables/useSettings.js'

const props = defineProps({ open: Boolean, activePanel: { type: String, default: 'left' } })
const emit = defineEmits(['close', 'connected'])
const { settings, loadSettings, saveSettings } = useSettings()
const modalElement = ref(null)
const selectedId = ref('')
const password = ref(''), keyPassphrase = ref('')
const busy = ref(false), loading = ref(false)
const permissionPending = ref(false)
let permissionController
const error = ref(''), warning = ref(''), configError = ref(''), credentialError = ref('')
const hostKey = ref(null), hostKeyErrorCode = ref('')
const authNeeds = ref('')
const capabilities = ref({ credentialStore: false, sshConfig: false, auto: true, agent: true })
const configHosts = ref([])
const credentials = ref({ password: false, keyPassphrase: false })
let modal, selectionGeneration = 0, showGeneration = 0
const emptyProfile = () => ({ id: '', protocol: 'sftp', name: '', host: '', port: 22, username: '', authType: 'auto', privateKeyPath: '', initialPath: '', trustedFingerprint: '', savePassword: false, saveKeyPassphrase: false, sshConfigHost: '' })
const draft = reactive(emptyProfile())
// This form edits SFTP profiles only. FTP/FTPS profiles stay in settings
// untouched: every save and delete writes the complete list.
const allProfiles = computed(() => settings.value.connections || [])
const profiles = computed(() => allProfiles.value.filter(isSftpProfile))
const otherProfileCount = computed(() => allProfiles.value.length - profiles.value.length)
const selected = computed(() => profiles.value.find(item => item.id === selectedId.value) || null)
const configIdentity = computed(() => configHosts.value.find(host => host.alias === draft.sshConfigHost)?.identities[0] || '')
const passwordVisible = computed(() => ['auto', 'password'].includes(draft.authType))
const passphraseVisible = computed(() => draft.authType === 'privateKey' || (draft.authType === 'auto' && (authNeeds.value === 'keyPassphrase' || credentials.value.keyPassphrase)))
const clearSecrets = () => { password.value = ''; keyPassphrase.value = '' }
const clearConnectionError = () => { error.value = ''; warning.value = ''; authNeeds.value = ''; hostKey.value = null; hostKeyErrorCode.value = '' }
const fill = (profile = null) => Object.assign(draft, emptyProfile(), profile || {})
const refreshCredentials = async () => {
  const generation = ++selectionGeneration, id = draft.id
  credentials.value = { password: false, keyPassphrase: false }; credentialError.value = ''
  if (!id || !capabilities.value.credentialStore || !profiles.value.some(profile => profile.id === id)) return
  const response = await connectionsApi.credentialStatus(id)
  if (generation !== selectionGeneration || draft.id !== id) return
  if (response.ok) credentials.value = response.credentials
  else credentialError.value = response.error.message
}
const select = (profile) => { selectedId.value = profile.id; fill(profile); clearSecrets(); clearConnectionError(); void refreshCredentials() }
const newProfile = () => { selectedId.value = ''; fill(); clearSecrets(); clearConnectionError(); void refreshCredentials() }
const selectConfig = (host) => {
  const existing = profiles.value.find(profile => profile.sshConfigHost === host.alias)
  selectedId.value = existing?.id || ''
  fill({ ...emptyProfile(), ...existing, id: existing?.id || crypto.randomUUID(), name: existing?.name || host.alias,
    host: host.host, port: host.port, username: host.username, authType: 'auto', sshConfigHost: host.alias,
    privateKeyPath: existing?.privateKeyPath || '' })
  clearSecrets(); clearConnectionError(); void refreshCredentials()
  if (host.unsupported) error.value = host.unsupported
}
const validateDraft = () => {
  if (!String(draft.name).trim()) throw Error('Connection name is required')
  if (!String(draft.host).trim()) throw Error('Host is required')
  if (!String(draft.username).trim()) throw Error('Username is required')
  if (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535) throw Error('Port must be between 1 and 65535')
  if (draft.authType === 'privateKey' && !String(draft.privateKeyPath).trim()) throw Error('Private key path is required')
  if (draft.initialPath && (!String(draft.initialPath).startsWith('/') || String(draft.initialPath).includes('\\'))) throw Error('Initial remote path must be an absolute POSIX path')
}
const normalizedDraft = () => {
  validateDraft()
  const endpointChanged = selected.value && (selected.value.host !== String(draft.host).trim() || selected.value.port !== Number(draft.port))
  return { ...draft, trustedFingerprint: endpointChanged ? '' : draft.trustedFingerprint,
    id: draft.id || crypto.randomUUID(), name: String(draft.name).trim(), host: String(draft.host).trim(), port: Number(draft.port),
    username: String(draft.username).trim(), privateKeyPath: String(draft.privateKeyPath).trim(), initialPath: String(draft.initialPath).trim(),
    savePassword: passwordVisible.value && draft.savePassword,
    saveKeyPassphrase: ['auto', 'privateKey'].includes(draft.authType) && draft.saveKeyPassphrase }
}
const saveProfile = async (profile = normalizedDraft()) => {
  const next = allProfiles.value.filter(item => item.id !== profile.id)
  const response = await saveSettings({ ...settings.value, connections: [...next, profile] })
  if (!response?.ok) throw Error(response?.error?.message || 'Unable to save connection')
  selectedId.value = profile.id
  const saved = response.settings.connections.find(item => item.id === profile.id)
  fill(saved); await refreshCredentials()
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
    newProfile()
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
const connect = async ({ trust = false } = {}) => {
  const trustedFingerprint = trust ? hostKey.value?.fingerprint : ''
  busy.value = true; clearConnectionError()
  try {
    if (draft.sshConfigHost) {
      const response = await connectionsApi.resolveSshHost(draft.sshConfigHost)
      if (!response.ok) throw Error(response.error.message)
      if (response.host.unsupported) throw Error(response.host.unsupported)
      Object.assign(draft, { host: response.host.host, port: response.host.port, username: response.host.username })
    }
    let profile = normalizedDraft()
    if (trustedFingerprint) profile.trustedFingerprint = trustedFingerprint
    profile = await saveProfile(profile)
    permissionController = new AbortController()
    const response = await connectionsApi.connect(profile, { password: password.value, keyPassphrase: keyPassphrase.value }, {
      signal: permissionController.signal, onPermissionWait: value => { permissionPending.value = value },
    })
    if (!response?.ok) {
      if (response?.error?.code === 'ECANCELLED') return
      hostKey.value = response.hostKey || response.error?.hostKey || null
      hostKeyErrorCode.value = response.error?.code || ''
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
    if (id) modalElement.value?.querySelector(`#${id}`)?.focus()
  }
}
const show = async () => {
  const generation = ++showGeneration
  loading.value = true; modal?.show(); clearConnectionError(); configError.value = ''
  try {
    const [loaded, supported] = await Promise.all([loadSettings({ force: true }), connectionsApi.capabilities()])
    if (generation !== showGeneration || !props.open) return
    if (!loaded.ok) throw Error(loaded.error.message)
    if (!supported.ok) throw Error(supported.error.message)
    capabilities.value = supported.capabilities
    if (profiles.value.length) select(profiles.value[0]); else newProfile()
    configHosts.value = []
    if (capabilities.value.sshConfig) {
      const config = await connectionsApi.sshConfigHosts()
      if (generation !== showGeneration || !props.open) return
      if (config.ok) configHosts.value = config.hosts
      else configError.value = config.error.message
    }
  } catch (cause) { error.value = cause.message } finally { if (generation === showGeneration) loading.value = false }
}
const close = () => { if (!busy.value) { clearSecrets(); emit('close') } }
const handleHide = (event) => { if (busy.value) event.preventDefault() }
const handleHidden = () => { clearSecrets(); if (props.open) emit('close') }
watch(() => props.open, value => { if (value) show(); else { showGeneration++; selectionGeneration++; clearSecrets(); modal?.hide() } })
watch(() => draft.authType, () => { clearSecrets(); authNeeds.value = '' })
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
            <p id="remote-connections-description" class="text-body-secondary small">Connect using SSH Agent, your SSH configuration, a private key or a password.</p>
            <div v-if="loading" class="d-flex align-items-center gap-2 text-body-secondary mb-3" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true" />Loading connections…</div>
            <div class="row g-3">
              <div class="col-4">
                <h2 class="h6 mb-2">Saved connections</h2>
                <div class="list-group remote-connections-list" :class="{ 'mb-2': profiles.length }">
                  <button v-for="profile in profiles" :key="profile.id" class="list-group-item list-group-item-action py-2" :class="{ active: selectedId === profile.id }" type="button" :disabled="busy || loading" @click="select(profile)">
                    <strong class="d-block text-truncate">{{ profile.name }}</strong><small class="d-block text-truncate">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</small>
                  </button>
                </div>
                <div v-if="!profiles.length" class="text-body-secondary small mb-2">No saved connections.</div>
                <div v-if="otherProfileCount" class="text-body-secondary small mb-2" role="note">{{ otherProfileCount }} FTP/FTPS {{ otherProfileCount === 1 ? 'connection is' : 'connections are' }} saved. Editing and connecting will be available when FTP support is added.</div>
                <template v-if="capabilities.sshConfig">
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
              <form class="col-8" @submit.prevent="connect()">
                <fieldset class="border-0 p-0 m-0" :disabled="busy || loading">
                <legend class="visually-hidden">Connection profile</legend>
                <div class="row g-2">
                  <div class="col-12"><label class="form-label" for="remote-name">Name</label><input id="remote-name" v-model="draft.name" class="form-control form-control-sm" required></div>
                  <div class="col-8"><label class="form-label" for="remote-host">Host</label><input id="remote-host" v-model="draft.host" class="form-control form-control-sm" required></div>
                  <div class="col-4"><label class="form-label" for="remote-port">Port</label><input id="remote-port" v-model.number="draft.port" class="form-control form-control-sm" type="number" min="1" max="65535" required></div>
                  <div class="col-6"><label class="form-label" for="remote-user">Username</label><input id="remote-user" v-model="draft.username" class="form-control form-control-sm" required></div>
                  <div class="col-6"><label class="form-label" for="remote-auth">Authentication</label><select id="remote-auth" v-model="draft.authType" class="form-select form-select-sm"><option value="auto">Auto (recommended)</option><option value="password">Password</option><option value="privateKey">Private key</option><option value="agent">SSH Agent</option></select></div>
                  <div v-if="draft.authType === 'auto'" class="col-12 form-text">Uses SSH Agent and available local keys, then a saved or supplied password.</div>
                  <div v-if="draft.sshConfigHost" class="col-12 form-text">SSH config: {{ draft.sshConfigHost }}</div>
                  <div v-if="configIdentity" class="col-12 form-text text-break">Identity: {{ configIdentity }}</div>
                  <div v-if="draft.authType === 'privateKey'" class="col-12"><label class="form-label" for="remote-key">Private key path</label><input id="remote-key" v-model="draft.privateKeyPath" class="form-control form-control-sm" required></div>
                  <div v-if="passwordVisible" class="col-12">
                    <label class="form-label" for="remote-password">Password{{ draft.authType === 'auto' ? ' (optional)' : '' }}</label>
                    <input id="remote-password" v-model="password" class="form-control form-control-sm" type="password" autocomplete="new-password" :placeholder="credentials.password ? 'Leave empty to use saved password' : ''" />
                    <div class="form-check mt-2"><input id="remote-save-password" v-model="draft.savePassword" class="form-check-input" type="checkbox" :disabled="!capabilities.credentialStore" /><label class="form-check-label" for="remote-save-password">Save password securely</label></div>
                    <div v-if="credentials.password" class="d-flex flex-wrap align-items-center gap-2 mt-1" role="status" aria-live="polite"><span class="small text-body-secondary">Saved securely in system credential store</span><button class="btn btn-sm toolbar-button toolbar-command" type="button" @click="forget('password')">Forget saved password</button></div>
                  </div>
                  <div v-if="passphraseVisible" class="col-12">
                    <label class="form-label" for="remote-passphrase">Key passphrase (optional)</label><input id="remote-passphrase" v-model="keyPassphrase" class="form-control form-control-sm" type="password" autocomplete="new-password" :placeholder="credentials.keyPassphrase ? 'Leave empty to use saved passphrase' : ''" />
                    <div class="form-check mt-2"><input id="remote-save-passphrase" v-model="draft.saveKeyPassphrase" class="form-check-input" type="checkbox" :disabled="!capabilities.credentialStore" /><label class="form-check-label" for="remote-save-passphrase">Save key passphrase securely</label></div>
                    <div v-if="credentials.keyPassphrase" class="d-flex flex-wrap align-items-center gap-2 mt-1" role="status" aria-live="polite"><span class="small text-body-secondary">Saved securely in system credential store</span><button class="btn btn-sm toolbar-button toolbar-command" type="button" @click="forget('keyPassphrase')">Forget saved passphrase</button></div>
                  </div>
                  <div v-if="passwordVisible || passphraseVisible" class="col-12 form-text">{{ capabilities.credentialStore ? 'Checked credentials are stored after a successful connection. Save stores the profile only.' : 'Secure credential storage is available in the native app. Credentials are used only for this session here.' }}</div>
                  <div v-if="credentialError" class="col-12 text-danger small" role="status">{{ credentialError }}</div>
                  <div class="col-12"><label class="form-label" for="remote-path">Initial remote directory</label><input id="remote-path" v-model="draft.initialPath" class="form-control form-control-sm" placeholder="/home/user"></div>
                </div>
                </fieldset>
              </form>
            </div>
            <div v-if="hostKey" class="alert mt-3 mb-0" :class="hostKeyErrorCode === 'EHOSTKEY_CHANGED' ? 'alert-danger' : 'alert-warning'" role="alert">
              <strong>{{ hostKeyErrorCode === 'EHOSTKEY_CHANGED' ? 'SSH host key changed — connection blocked' : 'Unknown SSH host key' }}</strong>
              <div>{{ hostKey.host }}</div>
              <div v-if="hostKey.previousFingerprint" class="small">Expected: <code>{{ hostKey.previousFingerprint }}</code></div>
              <div class="small">Presented: <code>{{ hostKey.fingerprint }}</code></div>
              <p v-if="hostKeyErrorCode === 'EHOSTKEY_CHANGED'" class="small mb-0 mt-2">Verify the server identity before replacing the saved fingerprint.</p>
              <button v-else class="btn btn-sm btn-primary d-block mt-2" type="button" :disabled="busy" @click="connect({ trust: true })">Trust and connect</button>
            </div>
            <div v-if="error && !hostKey" class="alert alert-danger mt-3 mb-0" role="alert">{{ error }}</div>
            <div v-if="warning" class="alert alert-warning mt-3 mb-0" role="status">{{ warning }}</div>
            <div v-if="permissionPending" class="small text-body-secondary mt-3" role="status">Waiting for macOS local network access. Respond to the system dialog, or enable Vesperwind in System Settings → Privacy &amp; Security → Local Network.</div>
          </div>
          <div class="modal-footer">
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
