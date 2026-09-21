<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { connectionsApi } from '../api/connections.js'
import { useSettings } from '../composables/useSettings.js'

const props = defineProps({ open: Boolean, activePanel: { type: String, default: 'left' } })
const emit = defineEmits(['close', 'connected'])
const { settings, loadSettings, saveSettings } = useSettings()
const modalElement = ref(null)
const selectedId = ref('')
const secret = ref('')
const busy = ref(false)
const error = ref('')
const hostKey = ref(null)
const hostKeyErrorCode = ref('')
let modal
const draft = reactive({ id: '', name: '', host: '', port: 22, username: '', authType: 'privateKey', privateKeyPath: '', initialPath: '', trustedFingerprint: '' })
const profiles = computed(() => settings.value.connections || [])
const selected = computed(() => profiles.value.find((item) => item.id === selectedId.value) || null)
const fill = (profile = null) => Object.assign(draft, profile || { id: '', name: '', host: '', port: 22, username: '', authType: 'privateKey', privateKeyPath: '', initialPath: '', trustedFingerprint: '' })
const clearConnectionError = () => { error.value = ''; hostKey.value = null; hostKeyErrorCode.value = '' }
const select = (profile) => { selectedId.value = profile.id; fill(profile); secret.value = ''; clearConnectionError() }
const newProfile = () => { selectedId.value = ''; fill(); secret.value = ''; clearConnectionError() }
const validateDraft = () => {
  if (!String(draft.name).trim()) throw new Error('Connection name is required')
  if (!String(draft.host).trim()) throw new Error('Host is required')
  if (!String(draft.username).trim()) throw new Error('Username is required')
  if (!Number.isInteger(Number(draft.port)) || Number(draft.port) < 1 || Number(draft.port) > 65535) throw new Error('Port must be between 1 and 65535')
  if (draft.authType === 'privateKey' && !String(draft.privateKeyPath).trim()) throw new Error('Private key path is required')
  if (draft.initialPath && (!String(draft.initialPath).startsWith('/') || String(draft.initialPath).includes('\\'))) throw new Error('Initial remote path must be an absolute POSIX path')
}
const normalizedDraft = () => {
  validateDraft()
  const endpointChanged = selected.value && (selected.value.host !== String(draft.host).trim() || selected.value.port !== Number.parseInt(draft.port, 10))
  return ({
  ...draft, trustedFingerprint: endpointChanged ? '' : draft.trustedFingerprint,
  id: draft.id || `${String(draft.name || draft.host).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'remote'}-${Date.now().toString(36)}`,
  name: String(draft.name).trim(), host: String(draft.host).trim(), port: Number.parseInt(draft.port, 10),
  username: String(draft.username).trim(), privateKeyPath: String(draft.privateKeyPath).trim(), initialPath: String(draft.initialPath).trim(),
  })
}
const saveProfile = async (profile = normalizedDraft()) => {
  const next = profiles.value.filter((item) => item.id !== profile.id)
  const response = await saveSettings({ ...settings.value, connections: [...next, profile] })
  if (!response?.ok) throw new Error(response?.error?.message || 'Unable to save connection')
  selectedId.value = profile.id
  fill(profile)
  return profile
}
const save = async () => {
  busy.value = true; clearConnectionError()
  try { await saveProfile() } catch (cause) { error.value = cause.message } finally { busy.value = false }
}
const remove = async () => {
  if (!selected.value) return
  busy.value = true; clearConnectionError()
  const response = await saveSettings({ ...settings.value, connections: profiles.value.filter((item) => item.id !== selected.value.id) })
  busy.value = false
  if (!response?.ok) error.value = response?.error?.message || 'Unable to delete connection'
  else newProfile()
}
const connect = async ({ trust = false } = {}) => {
  const trustedFingerprint = trust ? hostKey.value?.fingerprint : ''
  busy.value = true; clearConnectionError()
  try {
    let profile = normalizedDraft()
    if (trustedFingerprint) {
      profile.trustedFingerprint = trustedFingerprint
    }
    profile = await saveProfile(profile)
    const response = await connectionsApi.connect(profile, secret.value)
    if (!response?.ok) {
      hostKey.value = response.hostKey || response.error?.hostKey || null
      hostKeyErrorCode.value = response.error?.code || ''
      error.value = response.error.message
      return
    }
    secret.value = ''
    emit('connected', { ...response, profile, targetPanel: props.activePanel })
    emit('close')
  } catch (cause) { error.value = cause.message || 'Unable to connect' } finally { busy.value = false }
}
const show = async () => {
  await loadSettings({ force: true })
  if (profiles.value.length) select(profiles.value[0]); else newProfile()
  modal?.show()
}
const close = () => { if (!busy.value) emit('close') }
const handleHide = (event) => { if (busy.value) event.preventDefault() }
const handleHidden = () => { if (props.open) emit('close') }
watch(() => props.open, (value) => value ? show() : modal?.hide())
onMounted(() => {
  modal = new Modal(modalElement.value, { backdrop: 'static' })
  modalElement.value.addEventListener('hide.bs.modal', handleHide)
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)
  if (props.open) show()
})
onBeforeUnmount(() => {
  modalElement.value?.removeEventListener('hide.bs.modal', handleHide)
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  modal?.dispose()
  modal = null
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
            <p id="remote-connections-description" class="text-body-secondary small">Passwords and key passphrases are used only for this app session and are never saved.</p>
            <div class="row g-3">
              <div class="col-4">
                <div class="list-group remote-connections-list" :class="{ 'mb-2': profiles.length }">
                  <button v-for="profile in profiles" :key="profile.id" class="list-group-item list-group-item-action py-2" :class="{ active: selectedId === profile.id }" type="button" @click="select(profile)">
                    <strong class="d-block text-truncate">{{ profile.name }}</strong><small class="d-block text-truncate">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</small>
                  </button>
                </div>
                <button class="btn btn-sm btn-secondary w-100" type="button" @click="newProfile"><i class="mdi mdi-plus" aria-hidden="true" /> Add</button>
              </div>
              <form class="col-8" @submit.prevent="connect()">
                <div class="row g-2">
                  <div class="col-12"><label class="form-label" for="remote-name">Name</label><input id="remote-name" v-model="draft.name" class="form-control form-control-sm" required></div>
                  <div class="col-8"><label class="form-label" for="remote-host">Host</label><input id="remote-host" v-model="draft.host" class="form-control form-control-sm" required></div>
                  <div class="col-4"><label class="form-label" for="remote-port">Port</label><input id="remote-port" v-model.number="draft.port" class="form-control form-control-sm" type="number" min="1" max="65535" required></div>
                  <div class="col-6"><label class="form-label" for="remote-user">Username</label><input id="remote-user" v-model="draft.username" class="form-control form-control-sm" required></div>
                  <div class="col-6"><label class="form-label" for="remote-auth">Authentication</label><select id="remote-auth" v-model="draft.authType" class="form-select form-select-sm"><option value="privateKey">Private key</option><option value="password">Password</option></select></div>
                  <div v-if="draft.authType === 'privateKey'" class="col-12"><label class="form-label" for="remote-key">Private key path</label><input id="remote-key" v-model="draft.privateKeyPath" class="form-control form-control-sm" required></div>
                  <div class="col-12"><label class="form-label" for="remote-secret">{{ draft.authType === 'password' ? 'Password' : 'Key passphrase (optional)' }}</label><input id="remote-secret" v-model="secret" class="form-control form-control-sm" type="password" autocomplete="off"></div>
                  <div class="col-12"><label class="form-label" for="remote-path">Initial remote directory</label><input id="remote-path" v-model="draft.initialPath" class="form-control form-control-sm" placeholder="/home/user"></div>
                </div>
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
          </div>
          <div class="modal-footer">
            <button v-if="selected" class="btn btn-sm btn-danger me-auto" type="button" :disabled="busy" @click="remove">Delete</button>
            <button class="btn btn-sm btn-secondary" type="button" :disabled="busy" @click="close">Cancel</button>
            <button class="btn btn-sm btn-secondary" type="button" :disabled="busy" @click="save">Save</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="connect()">{{ busy ? 'Connecting…' : 'Connect' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
