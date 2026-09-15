<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  tab: {
    type: Object,
    default: null,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['save', 'discard', 'cancel'])
const modalElement = ref(null)
let modal = null

const handleHide = (event) => {
  if (props.busy) {
    event.preventDefault()
  }
}

const handleHidden = () => {
  if (props.open) {
    emit('cancel')
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      modal?.show()
    } else {
      modal?.hide()
    }
  },
)

onMounted(() => {
  modal = new Modal(modalElement.value, { backdrop: 'static' })
  modalElement.value.addEventListener('hide.bs.modal', handleHide)
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)

  if (props.open) {
    modal.show()
  }
})

onBeforeUnmount(() => {
  modalElement.value?.removeEventListener('hide.bs.modal', handleHide)
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  modal?.dispose()
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="modalElement"
      class="modal fade"
      tabindex="-1"
      aria-labelledby="unsaved-changes-title"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="unsaved-changes-title" class="modal-title fs-6">
              Save changes?
            </h1>
          </div>
          <div class="modal-body">
            <p class="mb-0">
              Save changes to <strong>{{ tab?.fileName }}</strong> before closing?
            </p>
            <div v-if="error" class="alert alert-danger mt-3 mb-0" role="alert">
              {{ error }}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-secondary" type="button" :disabled="busy" @click="$emit('cancel')">
              Cancel
            </button>
            <button class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="$emit('discard')">
              Don’t Save
            </button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="$emit('save')">
              <span v-if="busy" class="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
