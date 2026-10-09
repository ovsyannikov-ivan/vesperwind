<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { permissionsApi } from '../api/permissions.js'
import { usePermissionSetup } from '../composables/usePermissionSetup.js'

const props = defineProps({ open: Boolean })
const setup = usePermissionSetup()
const modalElement = ref(null), step = ref(0), busy = ref(false), error = ref('')
const results = ref({})
const steps = [
  { id: 'desktop', name: 'Desktop', description: 'Browse and manage files in your Desktop folder.' },
  { id: 'documents', name: 'Documents', description: 'Browse and manage files in your Documents folder.' },
  { id: 'network', name: 'Local network', description: 'Connect to SSH/SFTP servers on your local network.' },
]
const current = computed(() => steps[step.value])
let modal, controller, generation = 0
const stop = () => { generation++; controller?.abort(); controller = null; busy.value = false }
const request = async () => {
  const owner = ++generation, kind = current.value.id
  controller = new AbortController(); busy.value = true; error.value = ''
  const response = await permissionsApi.request(kind, { signal: controller.signal })
  if (owner !== generation) return
  busy.value = false; controller = null
  if (response.ok) results.value = { ...results.value, [kind]: 'allowed' }
  else if (response.error.code !== 'ECANCELLED') {
    results.value = { ...results.value, [kind]: 'unavailable' }
    error.value = response.error.message
  }
}
const next = () => { stop(); error.value = ''; step.value++ }
const finish = async () => {
  stop(); busy.value = true; error.value = ''
  const response = await setup.finish()
  busy.value = false
  if (!response.ok) error.value = response.error.message
}
const show = () => { stop(); step.value = 0; results.value = {}; error.value = ''; modal?.show() }
const handleShown = () => { if (!props.open) modal?.hide() }
watch(() => props.open, value => { if (value) show(); else { stop(); modal?.hide() } })
onMounted(() => {
  modal = new Modal(modalElement.value, { backdrop: 'static', keyboard: false })
  modalElement.value.addEventListener('shown.bs.modal', handleShown)
  if (props.open) show()
})
onBeforeUnmount(() => { stop(); modalElement.value?.removeEventListener('shown.bs.modal', handleShown); modal?.dispose() })
</script>

<template>
  <Teleport to="body">
    <div ref="modalElement" class="modal fade" tabindex="-1" aria-labelledby="permission-setup-title" aria-describedby="permission-setup-description">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="permission-setup-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi mdi-shield-check-outline" aria-hidden="true" />Set up access</h1>
            <button class="btn-close" type="button" aria-label="Set up later" :disabled="busy && !controller" @click="finish" />
          </div>
          <div class="modal-body">
            <p id="permission-setup-description" class="small text-body-secondary">macOS asks separately for each permission. You can skip a step and return here from Settings → General.</p>
            <div v-if="current">
              <p class="small text-body-secondary mb-2">Step {{ step + 1 }} of {{ steps.length }}</p>
              <h2 class="h6">{{ current.name }}</h2>
              <p class="small mb-3">{{ current.description }}</p>
              <div v-if="results[current.id] === 'allowed'" class="small text-success" role="status">Access is available.</div>
              <p v-else-if="busy && controller" class="small mb-0" role="status" aria-live="polite">Waiting for macOS access. Respond to the system dialog. If access was previously denied, enable Vesperwind in System Settings → Privacy &amp; Security, or skip this step.</p>
              <button v-else class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="request">Allow {{ current.name.toLowerCase() }} access</button>
            </div>
            <div v-else>
              <h2 class="h6">Ready to use Vesperwind</h2>
              <p class="small mb-0">Skipped permissions can be granted when you use the feature or from Settings → General → Set up access.</p>
            </div>
            <div v-if="error" class="alert alert-danger small mt-3 mb-0" role="alert">{{ error }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-neutral me-auto" type="button" :disabled="busy && !controller" @click="finish">Set up later</button>
            <button v-if="current && results[current.id] === 'allowed'" class="btn btn-sm btn-primary" type="button" :disabled="busy && !controller" @click="next">Next</button>
            <button v-else-if="current" class="btn btn-sm btn-neutral" type="button" :disabled="busy && !controller" @click="next">Skip</button>
            <button v-else class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="finish">Finish</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
