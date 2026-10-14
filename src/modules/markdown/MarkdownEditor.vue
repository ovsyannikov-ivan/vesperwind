<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Editor from '@toast-ui/editor'
import { redoDepth, undoDepth } from 'prosemirror-history'
import { media } from '../../api/media.js'
import { fromEditorMarkdown, toEditorMarkdown } from './markdownText.js'
import { visualEditingChangesMarkdown } from './markdownFidelity.js'
import { createMarkdownImageResolver, installMarkdownLinkGuard } from './markdownResources.js'
import { attachMarkdownRuntime } from './runtime.js'
import { markdownParserOptions, markdownRenderingOptions } from './toastOptions.js'
import { installPreviewRepair, renderWholePreview } from './toastPreview.js'
import './styles/markdown.scss'

// The WYSIWYG mode is labeled Preview and listed first in the mode switch.
Editor.setLanguage('en-US', { WYSIWYG: 'Preview' })

const props = defineProps({ tab: { type: Object, required: true }, visible: Boolean })
const emit = defineEmits(['save', 'history-state'])
const host = ref(null)
const mode = ref('wysiwyg')
const unsupportedMarkdown = ref(false)
const NARROW_WIDTH = 760
const SYNC_DELAY = 200

let editor = null
let lastMode = 'wysiwyg'
let baselines = {}
let syncTimer = null
let pendingSync = false
let fidelityTimer = null
let images = null
let removeLinkGuard = null
let detachRuntime = null
let resizeObserver = null

const viewOf = (editorType) => editorType === 'markdown' ? editor.mdEditor.view : editor.wwEditor.view

const emitHistory = () => {
  if (!editor) return
  const state = viewOf(mode.value).state
  emit('history-state', { tabId: props.tab.id, canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0 })
}

// Serializing the WYSIWYG model is the expensive step, so it trails typing.
const sync = () => {
  clearTimeout(syncTimer)
  syncTimer = null
  if (!editor || !pendingSync) return
  pendingSync = false
  props.tab.content = fromEditorMarkdown(editor.getMarkdown(), props.tab.textFormat)
  if (props.tab.content === props.tab.savedContent) {
    props.tab.dirty = false
    baselines[mode.value] = viewOf(mode.value).state.doc
  }
}

const scheduleSync = () => {
  pendingSync = true
  clearTimeout(syncTimer)
  syncTimer = setTimeout(sync, SYNC_DELAY)
}

const changed = (editorType) => {
  const doc = viewOf(editorType).state.doc
  if (editorType !== lastMode) {
    // TOAST UI rebuilt this mode's document from the other one; the text is unchanged.
    lastMode = editorType
    mode.value = editorType
    if (props.tab.dirty) scheduleSync()
    else baselines[editorType] = doc
    emitHistory()
    return
  }
  if (baselines[editorType] && doc.eq(baselines[editorType])) {
    pendingSync = false
    clearTimeout(syncTimer)
    props.tab.content = props.tab.savedContent
    props.tab.dirty = false
  } else {
    props.tab.revision += 1
    props.tab.dirty = true
    props.tab.saveError = null
    scheduleSync()
  }
  emitHistory()
}

const renderMarkdown = (markdown) => {
  const ToastMark = editor.toastMark.constructor
  return editor.preview.getRenderer().render(new ToastMark(markdown, markdownParserOptions).getRootNode())
}

// The Markdown editor still holds the source the visual document was built from.
const checkVisualFidelity = () => {
  clearTimeout(fidelityTimer)
  fidelityTimer = setTimeout(() => {
    if (!editor?.isWysiwygMode()) return
    try {
      unsupportedMarkdown.value = visualEditingChangesMarkdown(editor.mdEditor.getMarkdown(), editor.getMarkdown(), renderMarkdown)
    } catch {
      unsupportedMarkdown.value = true
    }
  })
}

const modeChanged = (editorType) => {
  mode.value = editorType
  // Rebuilding an unchanged document is not an edit the user could undo.
  if (!props.tab.dirty) resetHistory(viewOf(editorType))
  if (editorType === 'wysiwyg') checkVisualFidelity()
  emitHistory()
}

const resetHistory = (view) => {
  const plugins = view.state.plugins
  const history = plugins.find((plugin) => plugin.key === 'history$')
  if (!history) return
  view.updateState(view.state.reconfigure({ plugins: plugins.filter((plugin) => plugin !== history) }))
  view.updateState(view.state.reconfigure({ plugins }))
}

const updatePreviewStyle = () => {
  const style = (host.value?.clientWidth || NARROW_WIDTH) < NARROW_WIDTH ? 'tab' : 'vertical'
  if (editor && editor.getCurrentPreviewStyle() !== style) editor.changePreviewStyle(style)
}

const runHistory = (action) => {
  if (!editor || props.tab.saving) return
  editor.exec(action)
}

// The macOS Edit menu owns Cmd+Z; it reaches the focused document through this event.
const handleNativeHistory = (event) => {
  if (event.detail === 'selectAll') return
  if (!props.visible || !host.value?.contains(document.activeElement) ||
    !document.activeElement?.closest('.ProseMirror')) return
  event.preventDefault()
  runHistory(event.detail)
}

const switchToMarkdown = () => editor?.changeMode('markdown')

onMounted(() => {
  if (!host.value) return
  try {
    const source = toEditorMarkdown(props.tab.content)
    editor = new Editor({
      ...markdownRenderingOptions,
      el: host.value,
      height: '100%',
      initialValue: source,
      initialEditType: 'wysiwyg',
      previewStyle: host.value.clientWidth < NARROW_WIDTH ? 'tab' : 'vertical',
      autofocus: props.visible,
    })
    // Loading the file is not an edit: start both editors with empty histories.
    resetHistory(editor.mdEditor.view)
    resetHistory(editor.wwEditor.view)
    baselines = { markdown: editor.mdEditor.view.state.doc, wysiwyg: editor.wwEditor.view.state.doc }

    // Opening the Markdown source of an unchanged document shows the file as written,
    // not TOAST UI's regenerated Markdown.
    const markdownEditor = editor.mdEditor
    const setMarkdown = markdownEditor.setMarkdown.bind(markdownEditor)
    markdownEditor.setMarkdown = (markdown, cursorToEnd) =>
      setMarkdown(props.tab.dirty ? markdown : toEditorMarkdown(props.tab.savedContent), cursorToEnd)

    installPreviewRepair(editor)
    renderWholePreview(editor)
    editor.on('change', changed)
    editor.on('changeMode', modeChanged)
    removeLinkGuard = installMarkdownLinkGuard(host.value)
    images = createMarkdownImageResolver({
      root: host.value,
      location: () => ({ providerId: props.tab.filesystemId, path: props.tab.filePath }),
      prepare: (location) => media.prepare(location),
    })
    detachRuntime = attachMarkdownRuntime(props.tab.id, {
      flush: sync,
      markSaved: () => { baselines = { [mode.value]: viewOf(mode.value).state.doc } },
      undo: () => runHistory('undo'),
      redo: () => runHistory('redo'),
    })
    resizeObserver = new ResizeObserver(updatePreviewStyle)
    resizeObserver.observe(host.value)
    window.addEventListener('vesperwind:native-edit-history', handleNativeHistory)
    checkVisualFidelity()
    emitHistory()
  } catch (error) {
    props.tab.error = { code: 'EMARKDOWN_INIT', message: error?.message || 'Unable to initialize the Markdown editor' }
  }
})

watch(() => [props.tab.filesystemId, props.tab.filePath], () => images?.refresh())
// TOAST UI lays its toolbar out from measured widths. While the tab is hidden that
// width is 0, every button moves into the "more" menu and the toolbar recovers
// only after a throttled resize. Re-running its layout in the frame that shows
// the tab again, after v-show has restored it, avoids that flash.
const restoreToolbar = () => {
  const toolbar = host.value?.querySelector('.toastui-editor-defaultUI-toolbar')
  if (!editor || !toolbar?.clientWidth || !host.value.querySelector('.toastui-editor-dropdown-toolbar button')) return
  const style = editor.getCurrentPreviewStyle()
  editor.changePreviewStyle(style === 'tab' ? 'vertical' : 'tab')
  editor.changePreviewStyle(style)
}

watch(() => props.visible, (visible) => {
  if (!visible) return
  requestAnimationFrame(restoreToolbar)
  emitHistory()
})

onBeforeUnmount(() => {
  window.removeEventListener('vesperwind:native-edit-history', handleNativeHistory)
  clearTimeout(syncTimer)
  clearTimeout(fidelityTimer)
  resizeObserver?.disconnect()
  images?.dispose()
  removeLinkGuard?.()
  detachRuntime?.()
  editor?.destroy()
  editor = null
})

defineExpose({ undo: () => runHistory('undo'), redo: () => runHistory('redo') })
</script>

<template>
  <div class="markdown-editor vw-markdown" :aria-label="`Markdown document: ${tab.fileName}`">
    <div v-if="unsupportedMarkdown && mode === 'wysiwyg'" class="markdown-warning" role="note">
      <i class="mdi mdi-alert-outline" aria-hidden="true" />
      <span>The visual editor cannot represent some Markdown in this file. Editing here may rewrite it; Markdown mode keeps the source as written.</span>
      <button class="btn btn-sm toolbar-button toolbar-command" type="button" @click="switchToMarkdown">Edit as Markdown</button>
    </div>
    <div class="markdown-editor-surface">
      <div ref="host" class="markdown-editor-host" />
    </div>
  </div>
</template>
