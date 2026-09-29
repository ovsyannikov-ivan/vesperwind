<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { DocxEditor, useFonts } from '@docx-editor.dev/vue'
import { packagedFonts } from '@docx-editor.dev/fonts'
import { attachDocumentRuntime } from './runtime.js'
import '@docx-editor.dev/vue/styles.css'
import './styles/document.css'

const props = defineProps({ tab: { type: Object, required: true }, visible: Boolean })
const emit = defineEmits(['save'])
const editorRef = ref(null)
const fonts = useFonts(packagedFonts())
let detachRuntime = null

const ready = () => {
  detachRuntime?.()
  detachRuntime = attachDocumentRuntime(props.tab.id, {
    save: () => editorRef.value?.save(),
  })
}

const changed = (change) => {
  if (change?.source) return
  props.tab.revision += 1
  props.tab.dirty = true
  props.tab.saveError = null
}

watch(() => props.visible, async (visible) => {
  if (visible) {
    await nextTick()
    editorRef.value?.getEditor()?.relayout()
  }
})

onBeforeUnmount(() => {
  detachRuntime?.()
  detachRuntime = null
})
</script>

<template>
  <div class="word-editor" :aria-label="`Word document: ${tab.fileName}`">
    <div v-if="tab.importedFrom" class="word-import-notice" role="status">
      Imported from {{ tab.importedFrom }} — save as DOCX. The original file is unchanged.
    </div>
    <DocxEditor
      ref="editorRef"
      :document="tab.bytes"
      :title="tab.fileName"
      :fonts="fonts"
      color-mode="light"
      zoom-mode="auto"
      @ready="ready"
      @change="changed"
      @save="emit('save')"
    />
  </div>
</template>
