<script setup>
import * as monaco from 'monaco-editor'
import 'monaco-editor/editor/contrib/find/browser/findController'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '../editor/monacoEnvironment.js'
import { registerEditorLanguages } from '../editor/languages.js'
import { registerEnrichedLanguages } from '../editor/enrichedLanguages.js'
import { useSettings } from '../composables/useSettings.js'
import { applyEditorTheme } from '../editor/themes/registry.js'
import { getFormattingParser, FORMATTING_LANGUAGES } from '../editor/formatting/parsers.js'
import { formatInWorker } from '../editor/formatting/client.js'
import { applyFormattedText, replacementEdit } from '../editor/formatting/modelEdits.js'
import { registerSaveFormatter } from '../editor/formatting/saveFormatting.js'

registerEditorLanguages(monaco)
registerEnrichedLanguages(monaco)

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

const emit = defineEmits(['change', 'history-state', 'status-change'])
const container = ref(null)
const models = new Map()
const { settings } = useSettings()
const disposables = []
let unregisterFormatter
let themeSequence = 0
let formatterContext
let editor = null
let resizeObserver = null
let contentSubscription = null
let cursorSubscription = null
let optionsSubscription = null

const currentTheme = () => document.documentElement.dataset.bsTheme === 'light' ? 'vs' : 'vs-dark'

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
  editor.updateOptions({ readOnly: Boolean(tab?.loading || tab?.saving || tab?.formatting) })

  if (model && model.getValue() !== tab.content) {
    model.setValue(tab.content)
  }

  formatterContext?.set(Boolean(tab && getFormattingParser(tab.fileName)))
  emitHistoryState()
  emitStatus()

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

const handleThemeChange = async () => {
  const sequence = ++themeSequence
  await applyEditorTheme(monaco, settings.value.editor.theme,
    document.documentElement.dataset.bsTheme, () => sequence === themeSequence && Boolean(editor))
}

const emitHistoryState = () => {
  const model = editor?.getModel()

  emit('history-state', {
    tabId: props.activeTab?.id || null,
    canUndo: Boolean(model?.canUndo()),
    canRedo: Boolean(model?.canRedo()),
  })
}

const emitStatus = () => {
  const model = editor?.getModel()
  const position = editor?.getPosition()
  const options = model?.getOptions()

  emit('status-change', {
    tabId: model ? props.activeTab?.id : null,
    line: position?.lineNumber || 1,
    column: position?.column || 1,
    tabSize: options?.tabSize || 2,
    insertSpaces: options?.insertSpaces ?? true,
    eol: model?.getEOL() === '\r\n' ? 'CRLF' : 'LF',
  })
}

const requestFormatting = async (tab, fileName, options, cancellation) => {
  const model = getOrCreateModel(tab)
  if (!model) throw Object.assign(new Error('Formatting failed: document is unavailable'), { code: 'EFORMAT' })
  const version = model.getVersionId()
  const active = editor?.getModel() === model
  const cursorOffset = active ? model.getOffsetAt(editor.getPosition()) : -1
  const result = await formatInWorker({ text: model.getValue(), fileName,
    settings: { ...options }, cursorOffset })
  if (cancellation?.isCancellationRequested || model.isDisposed() ||
      version !== model.getVersionId() || !props.tabs.some((item) => item.id === tab.id)) {
    throw Object.assign(new Error('Formatting cancelled: document changed or closed'), { code: 'EFORMAT_CANCELLED' })
  }
  return { model, result }
}

const formatTabForSave = async (tab, fileName, options) => {
  const { model, result } = await requestFormatting(tab, fileName, options)
  const content = applyFormattedText(model, result, editor, monaco)
  // Monaco represents bare CR internally as LF; retain the disk serialization.
  tab.formattingEol = result.text.includes('\r') && !result.text.includes('\n') ? 'cr' : null
  emit('change', tab.id, content)
  emitHistoryState(); emitStatus()
  return { content, serialized: result.text }
}

const formatDocument = async () => {
  const tab = props.activeTab
  if (!tab || tab.saving || tab.formatting || !getFormattingParser(tab.fileName)) return
  tab.formatting = true; tab.saveError = null
  try { await formatTabForSave(tab, tab.fileName, settings.value.editor.formatting) }
  catch (error) { tab.saveError = { code: error.code || 'EFORMAT', message: error.message } }
  finally { tab.formatting = false; editor?.focus() }
}

const registerFormatters = () => {
  formatterContext = editor.createContextKey('vesperwindPrettier', false)
  disposables.push(editor.addAction({ id: 'vesperwind.formatDocument', label: 'Format Document (Prettier)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
    precondition: 'vesperwindPrettier && !editorReadonly', contextMenuGroupId: '1_modification',
    contextMenuOrder: 1.3, run: formatDocument }))
  for (const language of FORMATTING_LANGUAGES) {
    disposables.push(monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: 'Prettier',
      async provideDocumentFormattingEdits(model, _options, cancellation) {
        const tab = props.tabs.find((item) => models.get(item.id) === model)
        if (!tab || tab.saving || tab.formatting || !getFormattingParser(tab.fileName)) return []
        tab.formatting = true; tab.saveError = null
        try {
          const { result } = await requestFormatting(tab, tab.fileName, settings.value.editor.formatting, cancellation)
          const text = result.text.replace(/\r\n|\r|\n/g, model.getEOL())
          tab.formattingEol = result.text.includes('\r') && !result.text.includes('\n') ? 'cr' : null
          const edit = replacementEdit(model, text)
          return edit ? [edit] : []
        } catch (error) { tab.saveError = { code: error.code || 'EFORMAT', message: error.message }; return [] }
        finally { tab.formatting = false }
      },
    }))
  }
  unregisterFormatter = registerSaveFormatter(formatTabForSave)
}

const setIndentation = (options) => {
  const model = editor?.getModel()
  if (!model) return
  model.updateOptions(options)
  emitStatus()
  editor.focus()
}

const detectIndentation = () => {
  const model = editor?.getModel()
  if (!model) return
  const { insertSpaces, tabSize } = model.getOptions()
  model.detectIndentation(insertSpaces, tabSize)
  emitStatus()
  editor.focus()
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
const handleNativeHistory = (event) => {
  if (!props.visible || !editor?.hasTextFocus()) return
  event.preventDefault()
  if (!props.activeTab?.saving && !props.activeTab?.formatting) runCommand(event.detail)
}

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
  setIndentation,
  detectIndentation,
  formatDocument,
})

onMounted(() => {
  editor = monaco.editor.create(container.value, {
    automaticLayout: false,
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: true, side: 'right', showSlider: 'mouseover', maxColumn: 80 },
    padding: { top: 6 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    theme: currentTheme(),
  })
  registerFormatters()
  handleThemeChange()
  contentSubscription = editor.onDidChangeModelContent(() => {
    if (props.activeTab && editor.getModel()) {
      emit('change', props.activeTab.id, editor.getValue())
      emitHistoryState()
    }
  })
  cursorSubscription = editor.onDidChangeCursorPosition(emitStatus)
  optionsSubscription = editor.onDidChangeModelOptions(emitStatus)
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(container.value)
  window.addEventListener('vesperwind:theme-changed', handleThemeChange)
  window.addEventListener('vesperwind:native-edit-history', handleNativeHistory)
  syncActiveTab()
})

watch(
  () => [
    props.activeTab?.id,
    props.activeTab?.loading,
    props.activeTab?.saving,
    props.activeTab?.formatting,
    props.activeTab?.fileName,
    props.activeTab?.language,
    props.visible,
  ],
  syncActiveTab,
)

watch(
  () => props.tabs.map((tab) => tab.id),
  disposeClosedModels,
)

watch(() => settings.value.editor.theme, handleThemeChange)

onBeforeUnmount(() => {
  themeSequence++
  unregisterFormatter?.()
  for (const item of disposables) item.dispose()
  window.removeEventListener('vesperwind:theme-changed', handleThemeChange)
  window.removeEventListener('vesperwind:native-edit-history', handleNativeHistory)
  resizeObserver?.disconnect()
  contentSubscription?.dispose()
  cursorSubscription?.dispose()
  optionsSubscription?.dispose()
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
