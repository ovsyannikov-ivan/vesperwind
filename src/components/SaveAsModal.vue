<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { filesystem } from '../api/filesystem.js'
import { providerIdForConnection } from '../api/connections.js'
import { useSettings } from '../composables/useSettings.js'

const props = defineProps({ open: Boolean, tab: Object, busy: Boolean, error: String })
const emit = defineEmits(['save', 'cancel'])
const { settings } = useSettings()
const modalElement = ref(null)
const providerId = ref('local')
const directory = ref('')
const root = ref(null)
const folders = ref([])
const fileName = ref('')
const loading = ref(false)
const localError = ref('')
let modal = null
let loadToken = 0

const providers = computed(() => {
  const result = [{ id: 'local', name: 'Local' }]
  for (const profile of settings.value.connections || []) result.push({ id: providerIdForConnection(profile.id), name: profile.name || profile.host })
  if (props.tab?.filesystemId && !result.some((provider) => provider.id === props.tab.filesystemId)) {
    result.push({ id: props.tab.filesystemId, name: props.tab.filesystemId })
  }
  return result
})
const separator = computed(() => providerId.value === 'local' && directory.value.includes('\\') ? '\\' : '/')
const canGoUp = computed(() => Boolean(root.value && directory.value && directory.value !== root.value.path))
const join = (parent, child) => `${parent.replace(/[\\/]$/, '')}${separator.value}${child}`
const parentOf = (path) => {
  const position = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (position <= 0) return root.value?.path || path
  const candidate = path.slice(0, position)
  return root.value && candidate.length < root.value.path.length ? root.value.path : candidate
}

const visit = async (path) => {
  const token = ++loadToken
  loading.value = true
  localError.value = ''
  const response = await filesystem.readDir({ providerId: providerId.value, path })
  if (token !== loadToken) return
  loading.value = false
  if (!response.ok) { localError.value = response.error?.message || 'Unable to open this folder'; return }
  directory.value = path
  folders.value = response.entries.filter((entry) => entry.isDirectory)
}

const loadProvider = async (preferred = '') => {
  const token = ++loadToken
  loading.value = true
  localError.value = ''
  root.value = null
  directory.value = ''
  folders.value = []
  const response = await filesystem.getRoot(providerId.value)
  if (token !== loadToken) return
  if (!response.ok) {
    loading.value = false
    localError.value = response.error?.message || 'This provider is unavailable'
    return
  }
  root.value = response.root
  await visit(preferred || response.initial?.path || response.root.path)
}

const openDialog = () => {
  root.value = null
  providerId.value = props.tab?.filesystemId || 'local'
  const original = props.tab?.fileName || 'document.docx'
  fileName.value = props.tab?.importedFrom ? original.replace(/\.(rtf|doc)$/i, '.docx') : original
  const initial = parentOf(props.tab?.filePath || '')
  void loadProvider(initial)
  modal?.show()
}

const submit = () => {
  const name = fileName.value.trim()
  if (!directory.value || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    localError.value = 'Enter a valid file name'
    return
  }
  if (props.tab?.type === 'word' && !/\.docx$/i.test(name)) {
    localError.value = 'Word documents must be saved as .docx'
    return
  }
  emit('save', { providerId: providerId.value, directoryPath: directory.value,
    path: join(directory.value, name), name, root: root.value })
}

watch(() => props.open, (open) => { if (open) openDialog(); else modal?.hide() })
onMounted(() => {
  modal = new Modal(modalElement.value, { backdrop: 'static' })
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)
  if (props.open) openDialog()
})
const handleHidden = () => { if (props.open) emit('cancel') }
onBeforeUnmount(() => {
  loadToken++
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  modal?.dispose()
})
</script>

<template>
  <Teleport to="body">
    <div ref="modalElement" class="modal fade" tabindex="-1" aria-labelledby="save-as-title" aria-describedby="save-as-description">
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="save-as-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi mdi-content-save-move-outline" aria-hidden="true" />Save As</h1>
            <button class="btn-close" type="button" aria-label="Close" :disabled="busy" @click="emit('cancel')" />
          </div>
          <div class="modal-body">
            <p id="save-as-description" class="small text-body-secondary">Choose a provider and destination folder. Existing files will not be overwritten.</p>
            <label class="form-label" for="save-as-provider">Provider</label>
            <select id="save-as-provider" v-model="providerId" class="form-select form-select-sm mb-3" :disabled="busy" @change="loadProvider()">
              <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
            <label class="form-label" for="save-as-folder">Folder</label>
            <div class="input-group input-group-sm mb-2">
              <button class="btn btn-outline-secondary" type="button" title="Parent folder" :disabled="!canGoUp || loading || busy" @click="visit(parentOf(directory))"><i class="mdi mdi-arrow-up" aria-hidden="true" /></button>
              <input id="save-as-folder" class="form-control form-control-sm" :value="directory" readonly>
            </div>
            <div class="list-group overflow-auto mb-3" style="max-height: 12rem" aria-label="Subfolders">
              <button v-for="folder in folders" :key="folder.path" class="list-group-item list-group-item-action py-1 d-flex align-items-center gap-2" type="button" :disabled="busy" @click="visit(folder.path)"><i class="mdi mdi-folder-outline" aria-hidden="true" />{{ folder.name }}</button>
              <span v-if="!folders.length && !loading" class="small text-body-secondary p-2">No subfolders</span>
            </div>
            <label class="form-label" for="save-as-name">File name</label>
            <input id="save-as-name" v-model="fileName" class="form-control form-control-sm" :disabled="busy" @keydown.enter.prevent="submit">
            <div v-if="loading" class="small text-body-secondary mt-2"><span class="spinner-border spinner-border-sm" aria-hidden="true" /> Loading folders…</div>
            <div v-if="localError || error" class="alert alert-danger mt-3 mb-0" role="alert">{{ localError || error }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-neutral" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="busy || loading || !directory" @click="submit"><span v-if="busy" class="spinner-border spinner-border-sm me-2" aria-hidden="true" />Save</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
