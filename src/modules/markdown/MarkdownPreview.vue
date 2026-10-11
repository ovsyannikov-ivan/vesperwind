<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Viewer from '@toast-ui/editor/viewer'
import { media } from '../../api/media.js'
import { toEditorMarkdown } from './markdownText.js'
import { createMarkdownImageResolver, installMarkdownLinkGuard } from './markdownResources.js'
import { markdownRenderingOptions } from './toastOptions.js'
import { installPreviewRepair } from './toastPreview.js'
import './styles/markdown.scss'

const props = defineProps({
  markdown: { type: String, required: true },
  providerId: { type: String, required: true },
  path: { type: String, required: true },
})
const host = ref(null)
let viewer = null
let images = null
let removeLinkGuard = null

// The viewer toggles task checkboxes on mousedown; a read-only preview must not.
const blockTaskToggle = (event) => {
  if (event.target?.closest?.('[data-task]')) event.stopPropagation()
}

onMounted(() => {
  host.value.addEventListener('mousedown', blockTaskToggle, true)
  removeLinkGuard = installMarkdownLinkGuard(host.value)
  images = createMarkdownImageResolver({
    root: host.value,
    location: () => ({ providerId: props.providerId, path: props.path }),
    prepare: (location) => media.prepare(location),
  })
  viewer = new Viewer({ ...markdownRenderingOptions, el: host.value })
  installPreviewRepair(viewer)
  viewer.setMarkdown(toEditorMarkdown(props.markdown))
})

watch(() => props.markdown, (markdown) => viewer?.setMarkdown(toEditorMarkdown(markdown)))

onBeforeUnmount(() => {
  host.value?.removeEventListener('mousedown', blockTaskToggle, true)
  images?.dispose()
  removeLinkGuard?.()
  viewer?.destroy()
  viewer = null
})
</script>

<template>
  <div class="markdown-preview vw-markdown" tabindex="0" aria-label="Formatted Markdown preview">
    <p v-if="/^\s*$/.test(markdown)" class="markdown-preview-empty">This Markdown file is empty.</p>
    <div ref="host" class="markdown-preview-content selectable-text" />
  </div>
</template>
