<script setup>
import { computed, defineAsyncComponent, ref } from 'vue'
import { getFileIcon } from '../utils/fileIcons.js'
const PdfViewer = defineAsyncComponent(() => import('./PdfViewer.vue'))
const WordPreview = defineAsyncComponent(() => import('../modules/document/WordPreview.vue'))
const SpreadsheetPreview = defineAsyncComponent(() => import('../modules/spreadsheet/SpreadsheetPreview.vue'))
const props = defineProps({ preview: { type: Object, required: true }, compact: Boolean })
const pdf = ref(null)
const icon = computed(() => getFileIcon(props.preview.node).icon)
defineExpose({ openFind: () => pdf.value?.openFind() })
</script>
<template>
  <div class="file-preview" :class="{ 'is-compact': compact }">
    <div v-if="preview.loading" class="file-preview-message" role="status">
      <span class="spinner-border spinner-border-sm" aria-hidden="true" />{{ preview.statusMessage }}
      <span v-if="Number.isFinite(preview.preparationProgress)">{{ Math.round(preview.preparationProgress * 100) }}%</span>
    </div>
    <div v-else-if="preview.error" class="file-preview-message text-danger" role="alert">{{ preview.error.message }}</div>
    <div v-else-if="preview.message || ['metadata', 'audio', 'video'].includes(preview.kind)" class="file-preview-identity">
      <img v-if="preview.poster" :src="preview.poster" :alt="preview.node.name" class="file-preview-poster"><i v-else class="mdi" :class="icon" aria-hidden="true" />
      <p>{{ preview.message || (preview.kind === 'audio' ? 'Audio file' : preview.kind === 'video' ? 'Video file' : 'No built-in preview is available for this file.') }}</p>
      <p v-if="['audio', 'video'].includes(preview.kind)" class="small text-body-secondary">{{ preview.node.name }}</p>
      <p v-if="preview.mediaMetadata?.duration != null" class="small">Duration: {{ Math.round(preview.mediaMetadata.duration) }} s</p>
    </div>
    <pre v-else-if="preview.kind === 'text'" class="file-preview-text" tabindex="0">{{ preview.content }}</pre>
    <img v-else-if="preview.kind === 'image'" :src="preview.sourceUrl" :alt="preview.node.name" class="file-preview-image" @error="preview.error = { message: 'Unable to display this image' }">
    <PdfViewer v-else-if="['pdf', 'presentation'].includes(preview.kind)" ref="pdf" :tab="preview" :visible="true" :compact="compact" @state-change="(_id, state) => Object.assign(preview, state)" />
    <WordPreview v-else-if="preview.kind === 'word'" :bytes="preview.bytes" />
    <SpreadsheetPreview v-else-if="preview.kind === 'spreadsheet'" :model="preview.model" />
  </div>
</template>
<style lang="scss" scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  .file-preview-message { display: flex; gap: .5rem; padding: 1rem; margin: auto; }
  .file-preview-identity { margin: auto; padding: 1rem; text-align: center; overflow-wrap: anywhere; .mdi { font-size: 4rem; color: var(--bs-secondary-color); } }
  .file-preview-text { flex: 1; margin: 0; padding: 1rem; overflow: auto; user-select: text; font-size: .85rem; }
  .file-preview-poster { max-width: 100%; max-height: 300px; object-fit: contain; }
  .file-preview-image { width: 100%; height: 100%; min-height: 0; object-fit: contain; }
  :deep(.pdf-viewer) { flex: 1; min-height: 0; }
}
</style>
