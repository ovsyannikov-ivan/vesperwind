<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { entryNameError } from '../../shared/entryName.js'

const props = defineProps({ request: Object, busy: Boolean, error: String })
const emit = defineEmits(['confirm', 'cancel'])
const element = ref(null)
const input = ref(null)
const name = ref('')
const validationError = ref('')
const displayed = ref(null)
let modal
const submit = () => {
  validationError.value = entryNameError(name.value)
  if (!props.busy && !validationError.value) emit('confirm', name.value)
}
const cancel = () => {
  if (!props.busy) {
    modal?.hide()
    emit('cancel')
  }
}
const focusInput = () => {
  // Bootstrap ignores hide() during its opening transition.
  if (!props.request) modal?.hide()
  else input.value?.focus()
}
const preventBusyHide = (event) => { if (props.busy) event.preventDefault() }
watch(() => props.request, async (request) => {
  if (request) {
    displayed.value = request
    name.value = ''
    validationError.value = ''
    await nextTick()
    modal?.show()
  } else modal?.hide()
})
onMounted(() => {
  modal = new Modal(element.value, { backdrop: 'static' })
  element.value.addEventListener('shown.bs.modal', focusInput)
  element.value.addEventListener('hide.bs.modal', preventBusyHide)
  element.value.addEventListener('hidden.bs.modal', cancel)
})
onBeforeUnmount(() => {
  element.value?.removeEventListener('shown.bs.modal', focusInput)
  element.value?.removeEventListener('hide.bs.modal', preventBusyHide)
  element.value?.removeEventListener('hidden.bs.modal', cancel)
  modal?.dispose()
})
</script>

<template>
  <Teleport to="body">
    <div ref="element" class="modal fade" tabindex="-1" aria-labelledby="create-entry-title" aria-describedby="create-entry-description" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <form class="modal-content" @submit.prevent="submit">
          <div class="modal-header">
            <h1 id="create-entry-title" class="modal-title fs-6 d-flex align-items-center gap-2">
              <i
                class="mdi"
                :class="displayed?.kind === 'folder' ? 'mdi-folder-plus-outline' : 'mdi-file-plus-outline'"
                aria-hidden="true"
              />
              Create {{ displayed?.kind === 'folder' ? 'folder' : 'file' }}
            </h1>
            <button type="button" class="btn-close" aria-label="Close" :disabled="busy" @click="cancel" />
          </div>
          <div class="modal-body">
            <p id="create-entry-description" class="small text-break text-body-secondary">In: {{ displayed?.directory }}</p>
            <label for="create-entry-name" class="form-label">Name</label>
            <input id="create-entry-name" ref="input" v-model="name" class="form-control form-control-sm" autocomplete="off" :disabled="busy" :aria-describedby="validationError || error ? 'create-entry-error' : undefined" @input="validationError = ''">
            <div v-if="validationError || error" id="create-entry-error" class="text-danger mt-2" role="alert">{{ validationError || error }}</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="busy" @click="cancel">Cancel</button>
            <button type="submit" class="btn btn-sm btn-primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create' }}</button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
