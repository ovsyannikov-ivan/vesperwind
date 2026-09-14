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
})

const emit = defineEmits(['confirm', 'cancel'])
const modalElement = ref(null)
let modal = null

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
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)

  if (props.open) {
    modal.show()
  }
})

onBeforeUnmount(() => {
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
      aria-labelledby="revert-changes-title"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="revert-changes-title" class="modal-title fs-6">
              Revert changes?
            </h1>
            <button class="btn-close" type="button" aria-label="Close" @click="$emit('cancel')" />
          </div>
          <div class="modal-body">
            <p class="mb-0">
              Discard all unsaved changes to <strong>{{ tab?.fileName }}</strong> and restore the last saved version?
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-secondary" type="button" @click="$emit('cancel')">
              Cancel
            </button>
            <button class="btn btn-sm btn-danger" type="button" @click="$emit('confirm')">
              <i class="mdi mdi-refresh me-1" aria-hidden="true" />
              Revert
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
