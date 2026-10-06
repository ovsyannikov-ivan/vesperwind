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
    'overwrite-playlist': { title: 'Confirm overwrite', icon: 'mdi-file-replace-outline', button: 'Overwrite' },
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

  if (displayedRequest.value?.action === 'notice') {
    return { title: displayedRequest.value.title || 'Action failed', icon: 'mdi-alert-circle-outline', button: 'Close' }
  }
  if (displayedRequest.value?.paste?.duplicate) {
    return { title: 'Duplicate', icon: 'mdi-content-duplicate', button: 'Duplicate' }
  }
  if (displayedRequest.value?.paste) {
    return { title: 'Paste', icon: 'mdi-content-paste', button: 'Paste' }
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

// A fast operation (Paste, Duplicate) can finish while the show transition is
// still running; Bootstrap ignores hide() then, so close once it is shown.
const handleShown = () => {
  if (!props.open) modal?.hide()
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
  modalElement.value.addEventListener('shown.bs.modal', handleShown)

  if (props.open) {
    modal.show()
  }
})

onBeforeUnmount(() => {
  modalElement.value?.removeEventListener('hide.bs.modal', handleHide)
  modalElement.value?.removeEventListener('shown.bs.modal', handleShown)
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
              <template v-if="displayedRequest.action === 'notice'">
                {{ displayedRequest.message }}
              </template>
              <template v-else-if="displayedRequest.paste?.duplicate">
                Duplicating
                {{ displayedRequest.sources.length === 1 ? `“${displayedRequest.source.name}”` : `${displayedRequest.sources.length} items` }}
              </template>
              <template v-else-if="displayedRequest.paste">
                {{ displayedRequest.paste.action === 'move' ? 'Moving' : 'Copying' }}
                {{ displayedRequest.sources.length === 1 ? `“${displayedRequest.source.name}”` : `${displayedRequest.sources.length} items` }}
                to the folder <strong>“{{ displayedRequest.targetDirectory.name }}”</strong>
              </template>
              <template v-else-if="displayedRequest.action === 'overwrite-playlist'">
                Overwrite the existing file <strong>“{{ displayedRequest.source.name }}”</strong>?
              </template>
              <template v-else-if="displayedRequest.sources?.length > 1">
                {{ actionDetails.button }} {{ displayedRequest.sources.length }} selected items
                <template v-if="displayedRequest.action !== 'delete'">
                  to the folder <strong>“{{ displayedRequest.targetDirectory.name }}”</strong>
                </template>?
              </template>
              <template v-else-if="displayedRequest.action === 'delete' && displayedRequest.source.isDirectory">
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
              class="btn btn-sm btn-neutral"
              type="button"
              :disabled="busy"
              @click="requestCancel"
            >
              {{ displayedRequest?.action === 'notice' ? 'Close' : 'Cancel' }}
            </button>
            <button
              v-if="displayedRequest?.action !== 'notice'"
              :class="['delete', 'overwrite-playlist'].includes(displayedRequest?.action) ? 'btn-danger' : 'btn-primary'"
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
