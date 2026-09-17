<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  request: {
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

const emit = defineEmits(['confirm', 'cancel'])
const modalElement = ref(null)
const displayedRequest = ref(null)
let modal = null

const actionDetails = computed(() => {
  const details = {
    copy: {
      title: 'Confirm copy',
      icon: 'mdi-content-copy',
      button: 'Copy',
    },
    move: {
      title: 'Confirm move',
      icon: 'mdi-file-move-outline',
      button: 'Move',
    },
    delete: {
      title: 'Confirm deletion',
      icon: 'mdi-delete-outline',
      button: 'Delete',
    },
  }

  return details[displayedRequest.value?.action] || details.copy
})

const requestCancel = () => {
  if (!props.busy) {
    emit('cancel')
  }
}

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
  () => props.request,
  (request) => {
    if (request) {
      displayedRequest.value = request
    }
  },
  { immediate: true },
)

watch(
  () => props.open,
  (isOpen) => {
    if (!modal) {
      return
    }

    if (isOpen) {
      modal.show()
    } else {
      modal.hide()
    }
  },
)

onMounted(() => {
  modal = new Modal(modalElement.value)
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
  modal = null
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="modalElement"
      class="modal fade"
      tabindex="-1"
      aria-labelledby="file-operation-confirm-title"
      aria-describedby="file-operation-confirm-description"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h1
              id="file-operation-confirm-title"
              class="modal-title fs-6 d-flex align-items-center gap-2"
            >
              <i class="mdi" :class="actionDetails.icon" aria-hidden="true" />
              {{ actionDetails.title }}
            </h1>
            <button
              class="btn-close"
              type="button"
              aria-label="Close"
              :disabled="busy"
              @click="requestCancel"
            />
          </div>

          <div v-if="displayedRequest" class="modal-body">
            <p id="file-operation-confirm-description" class="mb-3">
              <template
                v-if="displayedRequest.action === 'delete' && displayedRequest.source.isDirectory"
              >
                Are you sure you want to delete the folder
                <strong>“{{ displayedRequest.source.name }}”</strong> and everything inside it?
              </template>
              <template v-else-if="displayedRequest.action === 'delete'">
                Are you sure you want to delete
                <strong>“{{ displayedRequest.source.name }}”</strong>?
              </template>
              <template v-else>
                {{ actionDetails.button }}
                <strong>“{{ displayedRequest.source.name }}”</strong> to the folder
                <strong>“{{ displayedRequest.targetDirectory.name }}”</strong>?
              </template>
            </p>

            <div
              v-if="displayedRequest.action === 'delete'"
              class="alert alert-warning d-flex align-items-start gap-2 mb-0"
              role="alert"
            >
              <i class="mdi mdi-alert-outline" aria-hidden="true" />
              <span>This action cannot be undone.</span>
            </div>

            <div
              v-if="error"
              class="alert alert-danger d-flex align-items-start gap-2 mt-3 mb-0"
              role="alert"
            >
              <i class="mdi mdi-alert-circle-outline" aria-hidden="true" />
              <span>{{ error }}</span>
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="btn btn-sm btn-secondary"
              type="button"
              :disabled="busy"
              @click="requestCancel"
            >
              Cancel
            </button>
            <button
              :class="displayedRequest?.action === 'delete' ? 'btn-danger' : 'btn-primary'"
              class="btn btn-sm"
              type="button"
              :disabled="busy"
              @click="$emit('confirm')"
            >
              <span
                v-if="busy"
                class="spinner-border spinner-border-sm me-2"
                aria-hidden="true"
              />
              {{ actionDetails.button }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
