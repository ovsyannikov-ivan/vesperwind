<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import CustomMediaPlayer from './CustomMediaPlayer.vue'
import { getFileIcon } from '../utils/fileIcons.js'
import { getFileExtension } from '../../shared/mediaTypes.js'
import { formatFileSize, formatModifiedAtTitle } from '../utils/fileMetadata.js'
import { canCloseQuickLook } from '../utils/quickLookKeyboard.js'

const PdfViewer = defineAsyncComponent(() => import('./PdfViewer.vue'))
const WordPreview = defineAsyncComponent(() => import('../modules/document/WordPreview.vue'))
const SpreadsheetPreview = defineAsyncComponent(() => import('../modules/spreadsheet/SpreadsheetPreview.vue'))
const props = defineProps({ preview: { type: Object, required: true } })
const emit = defineEmits(['close'])
const element = ref(null)
const pdf = ref(null)
const playbackError = ref('')
const preparationPercent = computed(() => Number.isFinite(props.preview.preparationProgress)
  ? `${Math.round(Math.max(0, Math.min(1, props.preview.preparationProgress)) * 100)}%` : '')
const icon = computed(() => getFileIcon(props.preview.node).icon)
let modal = null
let previousFocus = null
const handleKeydown = (event) => {
  if (event.defaultPrevented) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && ['pdf', 'presentation'].includes(props.preview.kind)) {
    event.preventDefault()
    void pdf.value?.openFind()
  } else if (canCloseQuickLook(event)) {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
  // Space belongs to audio/PDF controls and text selection while this dialog owns focus.
}
onMounted(() => {
  previousFocus = document.activeElement
  modal = new Modal(element.value, { keyboard: false })
  modal.show()
  element.value.addEventListener('hidden.bs.modal', () => emit('close'), { once: true })
})
onBeforeUnmount(() => {
  modal?.hide()
  modal?.dispose()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div ref="element" class="modal quick-look-modal" :class="{ 'is-audio': preview.kind === 'audio' }" tabindex="-1" aria-labelledby="quick-look-title" aria-describedby="quick-look-description" @keydown="handleKeydown">
      <div class="modal-dialog modal-xl modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h1 id="quick-look-title" class="modal-title fs-6 d-flex align-items-center gap-2">
              <i class="mdi" :class="icon" aria-hidden="true" />{{ preview.node.name }}
            </h1>
            <button class="btn-close" type="button" aria-label="Close Quick Look" @click="emit('close')" />
          </div>
          <div class="modal-body">
            <p id="quick-look-description" class="visually-hidden">Temporary read-only file preview</p>
            <div v-if="preview.loading" class="quick-look-message" role="status"><span class="spinner-border spinner-border-sm" aria-hidden="true" />{{ preview.statusMessage }}<span v-if="preparationPercent">{{ preparationPercent }}</span></div>
            <div v-else-if="preview.error" class="quick-look-message text-danger" role="alert">{{ preview.error.message }}</div>
            <template v-else-if="preview.kind === 'metadata' || preview.message">
              <div class="quick-look-metadata">
                <i class="mdi quick-look-file-icon" :class="icon" aria-hidden="true" />
                <p>{{ preview.message || 'No richer built-in preview is available for this file.' }}</p>
                <dl>
                  <dt>Name</dt><dd>{{ preview.node.name }}</dd>
                  <dt>Type</dt><dd>{{ getFileExtension(preview.node.name).toUpperCase() || 'File' }}</dd>
                  <dt>Size</dt><dd>{{ formatFileSize(preview.node.size) }}</dd>
                  <dt>Modified</dt><dd>{{ formatModifiedAtTitle(preview.node.modifiedAt) || '—' }}</dd>
                  <dt>Path</dt><dd>{{ preview.node.path }}</dd>
                </dl>
              </div>
            </template>
            <pre v-else-if="preview.kind === 'text'" class="quick-look-text" tabindex="0">{{ preview.content }}</pre>
            <div v-else-if="preview.kind === 'audio'" class="quick-look-audio">
              <i class="mdi mdi-music-circle-outline quick-look-file-icon" aria-hidden="true" />
              <CustomMediaPlayer kind="audio" :src="preview.sourceUrl" :provider-id="preview.providerId" :path="preview.node.path" :autoplay="true" :history-enabled="false" @error="playbackError = 'This audio could not be played'" />
              <p v-if="playbackError" class="text-danger" role="alert">{{ playbackError }}</p>
            </div>
            <PdfViewer v-else-if="['pdf', 'presentation'].includes(preview.kind)" ref="pdf" :tab="preview" :visible="true" @state-change="(_id, state) => Object.assign(preview, state)" />
            <WordPreview v-else-if="preview.kind === 'word'" :bytes="preview.bytes" />
            <SpreadsheetPreview v-else-if="preview.kind === 'spreadsheet'" :model="preview.model" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.quick-look-modal .modal-content { height: min(82vh, 900px); }
.quick-look-modal.is-audio .modal-dialog { max-width: 760px; }
.quick-look-modal.is-audio .modal-content { height: auto; min-height: 220px; }
.modal-body { padding: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.modal-title { min-width: 0; overflow-wrap: anywhere; }
.quick-look-message { display: flex; gap: .75rem; padding: 2rem; margin: auto; }
.quick-look-text { flex: 1; margin: 0; padding: 1rem; overflow: auto; white-space: pre; user-select: text; font-size: .85rem; line-height: 1.5; }
.quick-look-metadata { margin: auto; padding: 2rem; max-width: 100%; overflow: auto; user-select: text; }
.quick-look-file-icon { font-size: 4rem; color: var(--bs-secondary-color); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .5rem 1.5rem; }
dd { margin: 0; overflow-wrap: anywhere; }
.quick-look-audio { width: min(90%, 650px); margin: auto; padding: 1.5rem 0; display: flex; flex-direction: column; gap: 1rem; text-align: center; }
.quick-look-modal :deep(.pdf-viewer) { flex: 1; min-height: 0; }
</style>
