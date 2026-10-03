<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
const props = defineProps({ open: Boolean, request: { type: Object, default: null }, busy: Boolean,
  cancelling: Boolean, progress: { type: Object, default: null }, error: { type: Object, default: null } })
const emit = defineEmits(['submit', 'cancel'])
const element = ref(null), displayed = ref(null), name = ref(''), targetPath = ref('')
let modal
const creating = computed(() => displayed.value?.action === 'create')
watch(() => props.request, (request) => {
  if (request) { displayed.value = request; name.value = request.name; targetPath.value = request.target.path }
}, { immediate: true })
watch(() => props.open, (open) => { if (open) modal?.show(); else modal?.hide() })
const cancel = () => { if (!props.cancelling) emit('cancel') }
const hide = (event) => { if (props.busy) { event.preventDefault(); cancel() } }
const hidden = () => { if (props.open) emit('cancel') }
onMounted(() => {
  modal = new Modal(element.value)
  element.value.addEventListener('hide.bs.modal', hide)
  element.value.addEventListener('hidden.bs.modal', hidden)
  if (props.open) modal.show()
})
onBeforeUnmount(() => {
  element.value?.removeEventListener('hide.bs.modal', hide)
  element.value?.removeEventListener('hidden.bs.modal', hidden)
  modal?.dispose()
})
</script>
<template>
  <Teleport to="body">
    <div ref="element" class="modal fade" tabindex="-1" aria-labelledby="archive-operation-title" aria-describedby="archive-operation-description" aria-hidden="true" @keydown.esc.stop.prevent="cancel">
      <div class="modal-dialog modal-dialog-centered"><form class="modal-content" @submit.prevent="$emit('submit', { name, targetPath })">
        <div class="modal-header">
          <h1 id="archive-operation-title" class="modal-title fs-6 d-flex align-items-center gap-2"><i class="mdi mdi-folder-zip-outline" aria-hidden="true" />{{ creating ? 'Create ZIP archive' : 'Extract archive' }}</h1>
          <button class="btn-close" type="button" aria-label="Close" :disabled="cancelling" @click="cancel" />
        </div>
        <div v-if="displayed" class="modal-body">
          <p id="archive-operation-description" class="small mb-3">{{ creating ? `Archive ${displayed.sources.length} selected item(s).` : `Extract ${displayed.sources[0].name} into a new folder.` }} Existing items will be preserved.</p>
          <div class="mb-3"><label for="archive-target" class="form-label">Destination directory</label><input id="archive-target" v-model="targetPath" class="form-control form-control-sm" :disabled="busy" required autocomplete="off" spellcheck="false"></div>
          <div class="mb-3"><label for="archive-name" class="form-label">{{ creating ? 'ZIP filename' : 'New folder name' }}</label><input id="archive-name" v-model="name" class="form-control form-control-sm" :disabled="busy" required autocomplete="off"></div>
          <p v-if="busy" class="small mb-0" role="status" aria-live="polite">{{ cancelling ? 'Cancelling…' : 'Working…' }} {{ progress?.entries || 0 }} entries · {{ ((progress?.bytes || 0) / 1048576).toFixed(1) }} MB</p>
          <div v-if="error" class="alert alert-danger py-2 small mb-0" role="alert"><strong>{{ error.code }}</strong>: {{ error.message }}<details v-if="error.nativeError" class="mt-1"><summary>Details</summary><pre class="text-wrap mb-0">{{ error.nativeError }}</pre></details></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-sm btn-neutral" type="button" :disabled="cancelling" @click="cancel">{{ busy ? 'Cancel operation' : 'Cancel' }}</button>
          <button class="btn btn-sm btn-primary" type="submit" :disabled="busy">{{ creating ? 'Create ZIP' : 'Extract' }}</button>
        </div>
      </form></div>
    </div>
  </Teleport>
</template>
