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
import { configureLanguageServices, INTELLIGENT_EDITOR_OPTIONS, syncLanguageModels } from '../editor/languageServices.js'
import { editorModelUri } from '../editor/modelUri.js'
import { moveModelHistory } from '../editor/modelHistory.js'
import { installEditorNavigation } from '../editor/navigation.js'

registerEditorLanguages(monaco)
registerEnrichedLanguages(monaco)
configureLanguageServices(monaco)

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

const emit = defineEmits(['change', 'history-state', 'status-change', 'activate-tab'])
const container = ref(null)
const models = new Map()
const modelSubscriptions = new Map()
const viewStates = new Map()
const { settings } = useSettings()
const disposables = []
const formattingProviders = []
let formattingGeneration = 0
let unregisterFormatter
let themeSequence = 0
let formatterContext
let editor = null
let resizeObserver = null
let syncTimer
let scriptIdentity = ''
let cursorSubscription = null
let optionsSubscription = null

const currentTheme = () => document.documentElement.dataset.bsTheme === 'light' ? 'vs' : 'vs-dark'
const isFormattingEnabled = () => settings.value.editor.formatting.enabled !== false
const updateFormattingContext = () => {
  formatterContext?.set(Boolean(isFormattingEnabled() && props.activeTab && getFormattingParser(props.activeTab.fileName)))
}

const scheduleModelSync = () => {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const identity = [...models.values()].filter(model => ['javascript', 'typescript'].includes(model.getLanguageId()))
      .map(model => `${model.getLanguageId()}:${model.uri.toString()}`).sort().join('\n')
    const changed = identity !== scriptIdentity
    scriptIdentity = identity
    void syncLanguageModels(monaco, models.values(), changed)
  }, 50)
}

const observeModel = (tab, model) => {
  modelSubscriptions.get(tab.id)?.dispose()
  modelSubscriptions.set(tab.id, model.onDidChangeContent(() => {
    // Bulk symbol rename also edits inactive models. Never attribute their text
    // to whichever tab happens to be active.
    emit('change', tab.id, model.getValue())
    if (editor?.getModel() === model) { emitHistoryState(); emitStatus() }
  }))
}

const getOrCreateModel = (tab) => {
  if (!tab || tab.loading || tab.error) {
    return null
  }

  const uri = editorModelUri(monaco, tab)
  let model = models.get(tab.id)
  if (model && model.uri.toString() !== uri.toString()) {
    // File rename and Save As change semantic identity, not the editor tab ID.
    // Keep buffers, indentation, history and the active viewport during rebind.
    const active = editor?.getModel() === model
    const view = active ? editor.saveViewState() : viewStates.get(tab.id)
    const occupied = monaco.editor.getModel(uri)
    if (occupied && occupied !== model) return model
    const replacement = monaco.editor.createModel(model.getValue(), tab.language, uri)
    replacement.updateOptions(model.getOptions())
    try { moveModelHistory(model, replacement) }
    catch (error) {
      replacement.dispose()
      console.warn('Editor model rename deferred:', error)
      return model
    }
    modelSubscriptions.get(tab.id)?.dispose()
    models.set(tab.id, replacement)
    if (active) { editor.setModel(replacement); if (view) editor.restoreViewState(view) }
    model.dispose()
    model = replacement
    observeModel(tab, model)
    scheduleModelSync()
  }
  if (!model) {
    model = monaco.editor.createModel(tab.content, tab.language, uri)
    models.set(tab.id, model)
    observeModel(tab, model)
    scheduleModelSync()
  }
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
  if (editor.getModel() !== model) {
    const old = [...models].find(([, candidate]) => candidate === editor.getModel())
    if (old) viewStates.set(old[0], editor.saveViewState())
    editor.setModel(model)
    const view = tab && viewStates.get(tab.id)
    if (view) editor.restoreViewState(view)
  }
  editor.updateOptions({ readOnly: Boolean(tab?.loading || tab?.saving || tab?.formatting) })

  if (model && model.getValue() !== tab.content) {
    model.setValue(tab.content)
  }

  updateFormattingContext()
  emitHistoryState()
  emitStatus()

  if (props.visible) {
    await nextTick()
    editor.layout()
    editor.focus()
  }
}

const syncOpenModels = () => {
  const openIds = new Set(props.tabs.map((tab) => tab.id))

  for (const [id, model] of models) {
    if (!openIds.has(id)) {
      modelSubscriptions.get(id)?.dispose()
      modelSubscriptions.delete(id)
      viewStates.delete(id)
      model.dispose()
      models.delete(id)
    }
  }
  for (const tab of props.tabs) getOrCreateModel(tab)
  scheduleModelSync()
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
  const markers = model ? monaco.editor.getModelMarkers({ resource: model.uri }) : []

  emit('status-change', {
    tabId: model ? props.activeTab?.id : null,
    line: position?.lineNumber || 1,
    column: position?.column || 1,
    tabSize: options?.tabSize || 2,
    insertSpaces: options?.insertSpaces ?? true,
    eol: model?.getEOL() === '\r\n' ? 'CRLF' : 'LF',
    errors: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Error).length,
    warnings: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Warning).length,
  })
}

const requestFormatting = async (tab, fileName, options, cancellation) => {
  const generation = formattingGeneration
  const model = getOrCreateModel(tab)
  if (!model) throw Object.assign(new Error('Formatting failed: document is unavailable'), { code: 'EFORMAT' })
  const version = model.getVersionId()
  const active = editor?.getModel() === model
  const cursorOffset = active ? model.getOffsetAt(editor.getPosition()) : -1
  const result = await formatInWorker({ text: model.getValue(), fileName,
    settings: { ...options }, cursorOffset })
  if (!isFormattingEnabled() || generation !== formattingGeneration) {
    throw Object.assign(new Error('Formatting cancelled: Prettier setting changed'), { code: 'EFORMAT_DISABLED' })
  }
  if (cancellation?.isCancellationRequested || model.isDisposed() ||
      version !== model.getVersionId() || !props.tabs.some((item) => item.id === tab.id)) {
    throw Object.assign(new Error('Formatting cancelled: document changed or closed'), { code: 'EFORMAT_CANCELLED' })
  }
  return { model, result }
}

const formatTabForSave = async (tab, fileName, options) => {
  if (!isFormattingEnabled() || options.enabled === false) return null
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
  if (!isFormattingEnabled() || !tab || tab.saving || tab.formatting || !getFormattingParser(tab.fileName)) return
  tab.formatting = true; tab.saveError = null
  try { await formatTabForSave(tab, tab.fileName, settings.value.editor.formatting) }
  catch (error) {
    if (error.code !== 'EFORMAT_DISABLED') tab.saveError = { code: error.code || 'EFORMAT', message: error.message }
  }
  finally { tab.formatting = false; editor?.focus() }
}

const syncFormattingProviders = () => {
  formattingGeneration++
  for (const provider of formattingProviders.splice(0)) provider.dispose()
  updateFormattingContext()
  if (!editor || !isFormattingEnabled()) return
  for (const language of FORMATTING_LANGUAGES) {
    formattingProviders.push(monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: 'Prettier',
      async provideDocumentFormattingEdits(model, _options, cancellation) {
        const tab = props.tabs.find((item) => models.get(item.id) === model)
        if (!isFormattingEnabled() || !tab || tab.saving || tab.formatting || !getFormattingParser(tab.fileName)) return []
        tab.formatting = true; tab.saveError = null
        try {
          const { result } = await requestFormatting(tab, tab.fileName, settings.value.editor.formatting, cancellation)
          const text = result.text.replace(/\r\n|\r|\n/g, model.getEOL())
          tab.formattingEol = result.text.includes('\r') && !result.text.includes('\n') ? 'cr' : null
          const edit = replacementEdit(model, text)
          return edit ? [edit] : []
        } catch (error) {
          if (error.code !== 'EFORMAT_DISABLED') tab.saveError = { code: error.code || 'EFORMAT', message: error.message }
          return []
        }
        finally { tab.formatting = false }
      },
    }))
  }
}

const registerFormatters = () => {
  formatterContext = editor.createContextKey('vesperwindPrettier', false)
  disposables.push(editor.addAction({ id: 'vesperwind.formatDocument', label: 'Format Document (Prettier)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
    precondition: 'vesperwindPrettier && !editorReadonly', contextMenuGroupId: '1_modification',
    contextMenuOrder: 1.3, run: formatDocument }))
  syncFormattingProviders()
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
    ...INTELLIGENT_EDITOR_OPTIONS,
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
  disposables.push(installEditorNavigation(monaco, editor,
    uri => uri && props.tabs.find(tab => models.get(tab.id)?.uri.toString() === uri.toString()),
    async id => { emit('activate-tab', id); await nextTick(); await syncActiveTab() }))
  disposables.push(monaco.editor.onDidChangeMarkers(resources => {
    if (resources.some(uri => uri.toString() === editor?.getModel()?.uri.toString())) emitStatus()
  }))
  cursorSubscription = editor.onDidChangeCursorPosition(emitStatus)
  optionsSubscription = editor.onDidChangeModelOptions(emitStatus)
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(container.value)
  window.addEventListener('vesperwind:theme-changed', handleThemeChange)
  window.addEventListener('vesperwind:native-edit-history', handleNativeHistory)
  syncOpenModels()
  syncActiveTab()
})

watch(
  () => [
    props.activeTab?.id,
    props.activeTab?.loading,
    props.activeTab?.saving,
    props.activeTab?.formatting,
    props.activeTab?.fileName,
    props.activeTab?.filePath,
    props.activeTab?.filesystemId,
    props.activeTab?.language,
    props.visible,
  ],
  syncActiveTab,
)

watch(
  () => props.tabs.map(tab => [tab.id, tab.loading, tab.error, tab.filesystemId, tab.filePath, tab.language]),
  syncOpenModels,
)

watch(() => settings.value.editor.theme, handleThemeChange)
watch(isFormattingEnabled, syncFormattingProviders, { flush: 'sync' })

onBeforeUnmount(() => {
  themeSequence++
  unregisterFormatter?.()
  formattingGeneration++
  for (const provider of formattingProviders.splice(0)) provider.dispose()
  for (const item of disposables) item.dispose()
  window.removeEventListener('vesperwind:theme-changed', handleThemeChange)
  window.removeEventListener('vesperwind:native-edit-history', handleNativeHistory)
  resizeObserver?.disconnect()
  clearTimeout(syncTimer)
  for (const subscription of modelSubscriptions.values()) subscription.dispose()
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
