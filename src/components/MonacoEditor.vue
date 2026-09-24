<script setup>
import * as monaco from 'monaco-editor'
import 'monaco-editor/editor/contrib/find/browser/findController'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '../editor/monacoEnvironment.js'
import { registerEditorLanguages } from '../editor/languages.js'
import {
  dark2026Theme,
  VESPERWIND_DARK_2026_THEME_ID,
} from '../editor/themes/dark2026.js'
import { htmlTokenRules } from '../editor/themes/htmlTokens.js'

registerEditorLanguages(monaco)
monaco.editor.defineTheme(VESPERWIND_DARK_2026_THEME_ID, {
  ...dark2026Theme,
  rules: [...dark2026Theme.rules, ...htmlTokenRules],
})

const props = defineProps({
  activeTab: {
    type: Object,
    default: null,
  },
  tabs: {
    type: Array,
    default: () => [],
  },
  visible: {
    type: Boolean,
    default: true,
  },
})

const emit = defineEmits(['change', 'history-state'])
const container = ref(null)
const models = new Map()
let editor = null
let resizeObserver = null
let contentSubscription = null

const currentTheme = () =>
  document.documentElement.dataset.bsTheme === 'light'
    ? 'vs'
    : VESPERWIND_DARK_2026_THEME_ID

const modelUri = (tab) =>
  monaco.Uri.from({
    scheme: 'vesperwind',
    authority: tab.filesystemId,
    path: `/editor/${encodeURIComponent(tab.id)}/${encodeURIComponent(tab.fileName)}`,
  })

const getOrCreateModel = (tab) => {
  if (!tab || tab.loading || tab.error) {
    return null
  }

  if (!models.has(tab.id)) {
    models.set(
      tab.id,
      monaco.editor.createModel(tab.content, tab.language, modelUri(tab)),
    )
  }

  const model = models.get(tab.id)
  if (model.getLanguageId() !== tab.language) {
    monaco.editor.setModelLanguage(model, tab.language)
  }
  return model
}

const syncActiveTab = async () => {
  if (!editor) {
    return
  }

  const tab = props.activeTab
  const model = getOrCreateModel(tab)
  editor.setModel(model)
  editor.updateOptions({ readOnly: Boolean(tab?.loading || tab?.saving) })

  if (model && model.getValue() !== tab.content) {
    model.setValue(tab.content)
  }

  emitHistoryState()

  if (props.visible) {
    await nextTick()
    editor.layout()
    editor.focus()
  }
}

const disposeClosedModels = () => {
  const openIds = new Set(props.tabs.map((tab) => tab.id))

  for (const [id, model] of models) {
    if (!openIds.has(id)) {
      model.dispose()
      models.delete(id)
    }
  }
}

const handleThemeChange = () => {
  monaco.editor.setTheme(currentTheme())
}

const emitHistoryState = () => {
  const model = editor?.getModel()

  emit('history-state', {
    tabId: props.activeTab?.id || null,
    canUndo: Boolean(model?.canUndo()),
    canRedo: Boolean(model?.canRedo()),
  })
}

const runCommand = (command) => {
  if (!editor?.getModel()) {
    return
  }

  editor.focus()
  editor.trigger('vesperwind', command, null)
  emitHistoryState()
}

const undo = () => runCommand('undo')
const redo = () => runCommand('redo')

const runFindAction = async (...actionIds) => {
  if (!editor?.getModel()) {
    return false
  }

  for (const actionId of actionIds) {
    const action = editor.getAction(actionId)

    if (action?.isSupported()) {
      await action.run()
      return true
    }
  }

  return false
}

const openFind = () => runFindAction('actions.find')
const openReplace = () =>
  runFindAction(
    'editor.action.startFindReplace',
    'editor.action.startFindReplaceAction',
  )
const findNext = () => runFindAction('editor.action.nextMatchFindAction')
const findPrevious = () =>
  runFindAction('editor.action.previousMatchFindAction')

const revertToSaved = () => {
  const model = editor?.getModel()

  if (!model || !props.activeTab) {
    return
  }

  model.setValue(props.activeTab.savedContent)
  editor.focus()
  emitHistoryState()
}

defineExpose({
  undo,
  redo,
  revertToSaved,
  openFind,
  openReplace,
  findNext,
  findPrevious,
})

onMounted(() => {
  editor = monaco.editor.create(container.value, {
    automaticLayout: false,
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    padding: { top: 6 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    theme: currentTheme(),
  })
  contentSubscription = editor.onDidChangeModelContent(() => {
    if (props.activeTab && editor.getModel()) {
      emit('change', props.activeTab.id, editor.getValue())
      emitHistoryState()
    }
  })
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(container.value)
  window.addEventListener('vesperwind:theme-changed', handleThemeChange)
  syncActiveTab()
})

watch(
  () => [
    props.activeTab?.id,
    props.activeTab?.loading,
    props.activeTab?.saving,
    props.activeTab?.language,
    props.visible,
  ],
  syncActiveTab,
)

watch(
  () => props.tabs.map((tab) => tab.id),
  disposeClosedModels,
)

onBeforeUnmount(() => {
  window.removeEventListener('vesperwind:theme-changed', handleThemeChange)
  resizeObserver?.disconnect()
  contentSubscription?.dispose()
  editor?.dispose()

  for (const model of models.values()) {
    model.dispose()
  }

  models.clear()
})
</script>

<template>
  <div ref="container" class="monaco-editor-host" />
</template>
