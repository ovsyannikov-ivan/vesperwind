<script setup>
import { DocxEditorRoot, DocxEditorViewport, DocxEditorContent, useFonts } from '@docx-editor.dev/vue'
import { packagedFonts } from '@docx-editor.dev/fonts'
import { useTheme } from '../../composables/useTheme.js'
import '@docx-editor.dev/vue/styles.css'

defineProps({ bytes: { type: Uint8Array, required: true } })
const fonts = useFonts(packagedFonts())
const { resolvedTheme } = useTheme()
</script>

<template>
  <div class="word-preview docx-editor" :class="{ dark: resolvedTheme === 'dark' }">
    <DocxEditorRoot :document="bytes" :fonts="fonts" mode="view" zoom-mode="auto">
      <DocxEditorViewport><DocxEditorContent /></DocxEditorViewport>
    </DocxEditorRoot>
  </div>
</template>

<style scoped>
.word-preview { height: 100%; min-height: 0; }
.word-preview :deep([data-testid="docx-editor-scroll"]) { height: 100%; }
</style>
