<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorLayout } from '../composables/useEditorLayout.js'
import { useEditorWorkspace } from '../composables/useEditorWorkspace.js'
import { getDocumentHandler } from '../editor/documentHandlers.js'
import { useSettings } from '../composables/useSettings.js'
import { getFormattingParser } from '../editor/formatting/parsers.js'
import {
  DOCUMENT_FIND_INTENTS,
  getDocumentFindIntent,
} from '../utils/documentFindShortcuts.js'
import EditorTree from './EditorTree.vue'
import MonacoEditor from './MonacoEditor.vue'
import PdfViewer from './PdfViewer.vue'
import RevertChangesModal from './RevertChangesModal.vue'
import SaveAsModal from './SaveAsModal.vue'
import Splitter from './Splitter.vue'
import UnsavedChangesModal from './UnsavedChangesModal.vue'

const props = defineProps({
  visible: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['show-files', 'open-file', 'empty'])
const workspaceElement = ref(null)
const monacoEditor = ref(null)
const { settings } = useSettings()
const pdfViewerRefs = new Map()
const pendingClose = ref(null)
const pendingRevert = ref(null)
const closeBusy = ref(false)
const closeError = ref('')
const saveAsTabId = ref(null)
const saveAsBusy = ref(false)
const saveAsError = ref('')
const saveAsCloseTabId = ref(null)
const historyState = ref({ tabId: null, canUndo: false, canRedo: false })
const editorPosition = ref({ tabId: null, line: 1, column: 1, tabSize: 2, insertSpaces: true, eol: 'LF' })
const indentationMenu = ref(null)
const indentationButton = ref(null)
const indentationMenuOpen = ref(false)
const { editorLayout, setTreeWidth, toggleTree } = useEditorLayout()
const {
  tabs,
  activeTab,
  activateTab,
  updateContent,
  updatePdfState,
  retryPdfTab,
  saveTab,
  closeTab,
} = useEditorWorkspace()

const contextKey = (tab) =>
  `${tab.filesystemId}:${tab.sourcePane}:${tab.sourceRootPath}`

const treeContexts = computed(() => {
  const contexts = new Map()

  for (const tab of tabs.value) {
    const key = contextKey(tab)

    if (!contexts.has(key)) {
      contexts.set(key, {
        key,
        filesystemId: tab.filesystemId,
        sourcePane: tab.sourcePane,
        sourceRootPath: tab.sourceRootPath,
        sourceRootName: tab.sourceRootName,
        filesystemRoot: tab.filesystemRoot,
        homePath: tab.homePath,
      })
    }
  }

  return [...contexts.values()]
})
const activeContextKey = computed(() =>
  activeTab.value ? contextKey(activeTab.value) : '',
)
const treeStyle = computed(() => ({ width: `${editorLayout.treeWidth}px` }))
const textTabs = computed(() => tabs.value.filter((tab) => tab.type === 'text'))
const pdfTabs = computed(() => tabs.value.filter((tab) => ['pdf', 'presentation'].includes(tab.type)))
const specializedTabs = computed(() => tabs.value.filter((tab) => getDocumentHandler(tab.type)?.component && !tab.loading && !tab.error))
const activeEditableTab = computed(() => activeTab.value && getDocumentHandler(activeTab.value.type)?.save ? activeTab.value : null)
const activeTextTab = computed(() =>
  activeTab.value?.type === 'text' ? activeTab.value : null,
)
const activeTabReady = computed(() =>
  Boolean(
    activeTextTab.value &&
      !activeTextTab.value.loading &&
      !activeTextTab.value.error,
  ),
)
const activeEditorPosition = computed(() =>
  editorPosition.value.tabId === activeTextTab.value?.id
    ? editorPosition.value
    : { line: 1, column: 1, tabSize: 2, insertSpaces: true, eol: 'LF' },
)
const indentationLabel = computed(() =>
  `${activeEditorPosition.value.insertSpaces ? 'Spaces' : 'Tabs'}: ${activeEditorPosition.value.tabSize}`,
)
const canUndo = computed(() =>
  Boolean(
    activeTabReady.value &&
      historyState.value.tabId === activeTextTab.value.id &&
      historyState.value.canUndo,
  ),
)
const canRedo = computed(() =>
  Boolean(
    activeTabReady.value &&
      historyState.value.tabId === activeTextTab.value.id &&
      historyState.value.canRedo,
  ),
)
const canSave = computed(() =>
  Boolean(
    activeEditableTab.value &&
      !activeEditableTab.value.loading &&
      !activeEditableTab.value.error &&
      activeEditableTab.value.dirty &&
      !activeEditableTab.value.saving && !activeEditableTab.value.formatting,
  ),
)
const canRevert = computed(() =>
  Boolean(
    activeTabReady.value &&
      activeTextTab.value.dirty &&
      !activeTextTab.value.saving,
  ),
)
const editorStatus = computed(() => {
  if (!activeEditableTab.value) {
    return ''
  }

  if (activeEditableTab.value.formatting) return 'Formatting…'

  if (activeEditableTab.value.saving) {
    return 'Saving…'
  }

  if (activeEditableTab.value.saveError) {
    return activeEditableTab.value.saveError.code?.startsWith('EFORMAT') ? 'Formatting failed' : 'Save failed'
  }

  return activeEditableTab.value.dirty ? 'Unsaved' : 'Saved'
})

const resizeTree = (delta) => {
  setTreeWidth(
    editorLayout.treeWidth + delta,
    workspaceElement.value?.clientWidth || window.innerWidth,
  )
}

const finishClose = (tabId) => {
  closeTab(tabId)
  pendingClose.value = null
  closeError.value = ''

  if (tabs.value.length === 0) {
    emit('empty')
  }
}

const requestClose = (tab) => {
  if (tab.saving || tab.formatting) return
  if (getDocumentHandler(tab.type)?.save && tab.dirty) {
    pendingClose.value = tab
    closeError.value = ''
    return
  }

  finishClose(tab.id)
}

const cancelClose = () => {
  if (!closeBusy.value) {
    pendingClose.value = null
    closeError.value = ''
  }
}

const discardAndClose = () => {
  if (pendingClose.value && !closeBusy.value) {
    finishClose(pendingClose.value.id)
  }
}

const saveAndClose = async () => {
  if (!pendingClose.value || closeBusy.value) {
    return
  }

  const tabId = pendingClose.value.id
  if (pendingClose.value.importedFrom) {
    saveAsCloseTabId.value = tabId
    pendingClose.value = null
    return
  }
  closeBusy.value = true
  closeError.value = ''
  const response = await saveTab(tabId)
  closeBusy.value = false

  if (!response?.ok) {
    closeError.value = response?.error?.message || 'Unable to save this file'
    return
  }

  if (!pendingClose.value?.dirty) finishClose(tabId)
}

const updateHistoryState = (state) => {
  historyState.value = state
}

const updateEditorPosition = (state) => {
  if (state.tabId !== editorPosition.value.tabId) indentationMenuOpen.value = false
  editorPosition.value = state
}

const setIndentation = (options) => {
  monacoEditor.value?.setIndentation(options)
  indentationMenuOpen.value = false
}

const detectIndentation = () => {
  monacoEditor.value?.detectIndentation()
  indentationMenuOpen.value = false
}

const handleIndentationPointerDown = (event) => {
  if (
    indentationMenuOpen.value &&
    !indentationMenu.value?.contains(event.target) &&
    !indentationButton.value?.contains(event.target)
  ) indentationMenuOpen.value = false
}

const handleIndentationKeydown = (event) => {
  if (event.key === 'Escape') {
    indentationMenuOpen.value = false
    indentationButton.value?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...(indentationMenu.value?.querySelectorAll('.dropdown-item') || [])]
  if (!items.length) return
  const current = items.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length
        : (current + items.length - 1) % items.length
  items[next].focus()
}

const requestSaveAs = (tab = activeEditableTab.value) => {
  if (!tab) return
  saveAsError.value = ''
  saveAsTabId.value = tab.id
}

const cancelSaveAs = () => {
  saveAsTabId.value = null
  saveAsCloseTabId.value = null
}

const startSaveAsAfterClose = () => {
  if (!saveAsCloseTabId.value) return
  const tab = tabs.value.find((item) => item.id === saveAsCloseTabId.value)
  if (tab) requestSaveAs(tab)
  else saveAsCloseTabId.value = null
}

const saveAs = async (destination) => {
  if (!saveAsTabId.value || saveAsBusy.value) return
  const tabId = saveAsTabId.value
  saveAsBusy.value = true
  saveAsError.value = ''
  const response = await saveTab(tabId, destination)
  saveAsBusy.value = false
  if (!response.ok) { saveAsError.value = response.error?.message || 'Unable to save this file'; return }
  saveAsTabId.value = null
  if (saveAsCloseTabId.value === tabId) {
    saveAsCloseTabId.value = null
    const tab = tabs.value.find((item) => item.id === tabId)
    if (tab && !tab.dirty) finishClose(tabId)
    return
  }
  if (pendingClose.value?.id === tabId && !pendingClose.value.dirty) finishClose(tabId)
}

const saveActiveTab = () => {
  if (!canSave.value) {
    return
  }
  if (activeEditableTab.value.importedFrom) { requestSaveAs(activeEditableTab.value); return }
  saveTab(activeEditableTab.value.id)
}

const undo = () => {
  if (canUndo.value) {
    monacoEditor.value?.undo()
  }
}

const redo = () => {
  if (canRedo.value) {
    monacoEditor.value?.redo()
  }
}

const requestRevert = () => {
  if (canRevert.value) {
    pendingRevert.value = activeTextTab.value
  }
}

const cancelRevert = () => {
  pendingRevert.value = null
}

const confirmRevert = () => {
  if (!pendingRevert.value) {
    return
  }

  monacoEditor.value?.revertToSaved()
  pendingRevert.value = null
}

const setPdfViewerRef = (element, tabId) => {
  if (element) {
    pdfViewerRefs.set(tabId, element)
  } else {
    pdfViewerRefs.delete(tabId)
  }
}

const runDocumentFindIntent = (intent) => {
  if (activeTextTab.value) {
    const actions = {
      [DOCUMENT_FIND_INTENTS.OPEN]: 'openFind',
      [DOCUMENT_FIND_INTENTS.OPEN_REPLACE]: 'openReplace',
      [DOCUMENT_FIND_INTENTS.NEXT]: 'findNext',
      [DOCUMENT_FIND_INTENTS.PREVIOUS]: 'findPrevious',
    }
    const action = actions[intent]
    return action ? monacoEditor.value?.[action]?.() : false
  }

  if (['pdf', 'presentation'].includes(activeTab.value?.type)) {
    const viewer = pdfViewerRefs.get(activeTab.value.id)
    const actions = {
      [DOCUMENT_FIND_INTENTS.OPEN]: 'openFind',
      [DOCUMENT_FIND_INTENTS.NEXT]: 'findNext',
      [DOCUMENT_FIND_INTENTS.PREVIOUS]: 'findPrevious',
      [DOCUMENT_FIND_INTENTS.CLOSE]: 'closeFind',
    }
    const action = actions[intent]
    return action ? viewer?.[action]?.() : false
  }

  return false
}

const handleEditorKeydown = (event) => {
  if (
    !props.visible ||
    pendingClose.value ||
    pendingRevert.value ||
    document.querySelector('.modal.show')
  ) {
    return
  }

  const findIntent = getDocumentFindIntent(event)

  if (findIntent) {
    const targetIsMonaco = event.target?.closest?.('.monaco-editor-host')

    if (activeTextTab.value && targetIsMonaco) {
      return
    }

    if (
      ['pdf', 'presentation'].includes(activeTab.value?.type) &&
      findIntent === DOCUMENT_FIND_INTENTS.OPEN_REPLACE
    ) {
      return
    }

    const handled = runDocumentFindIntent(findIntent)

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
    return
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
    event.preventDefault()
    event.stopPropagation()
    saveActiveTab()
  }
}

const handleBeforeUnload = (event) => {
  if (!tabs.value.some((tab) => getDocumentHandler(tab.type)?.save && tab.dirty)) {
    return
  }

  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  window.addEventListener('keydown', handleEditorKeydown, true)
  window.addEventListener('beforeunload', handleBeforeUnload)
  document.addEventListener('pointerdown', handleIndentationPointerDown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEditorKeydown, true)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  document.removeEventListener('pointerdown', handleIndentationPointerDown, true)
})
</script>

<template>
  <div ref="workspaceElement" class="editor-workspace">
    <aside v-show="editorLayout.treeVisible" class="editor-tree-pane" :style="treeStyle">
      <div class="editor-tree-toolbar">
        <button class="compact-button" type="button" title="Return to file panels" @click="$emit('show-files')">
          <i class="mdi mdi-arrow-left" aria-hidden="true" />
          Files
        </button>
        <span v-if="activeTab" class="editor-source-pane">{{ activeTab.sourcePane }}</span>
        <button class="editor-tree-toggle compact-icon-button" type="button" title="Hide Files sidebar" aria-label="Hide Files sidebar" @click="toggleTree"><i class="mdi mdi-chevron-left" aria-hidden="true" /></button>
      </div>

      <template v-for="context in treeContexts" :key="context.key">
        <EditorTree
          v-show="context.key === activeContextKey"
          :watch-active="visible && editorLayout.treeVisible && context.key === activeContextKey"
          :context="context"
          :active-file-path="context.key === activeContextKey ? activeTab?.filePath : ''"
          @open-file="$emit('open-file', $event)"
        />
      </template>
    </aside>

    <Splitter v-if="editorLayout.treeVisible" orientation="vertical" seam @resize="resizeTree" />

    <section class="editor-main">
      <div class="editor-header">
        <button v-if="!editorLayout.treeVisible" class="editor-tree-toggle editor-tree-reveal compact-icon-button" type="button" title="Show Files sidebar" aria-label="Show Files sidebar" @click="toggleTree"><i class="mdi mdi-file-tree-outline" aria-hidden="true" /></button>
        <div class="editor-tabs" role="tablist" aria-label="Open files">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="editor-tab"
            :class="{ 'is-active': tab.id === activeTab?.id }"
            type="button"
            role="tab"
            :aria-selected="tab.id === activeTab?.id"
            :title="tab.filePath"
            @click="activateTab(tab.id)"
          >
            <span v-if="tab.dirty" class="editor-dirty-marker" aria-label="Unsaved changes">●</span>
            <i
              v-else
              class="mdi"
              :class="getDocumentHandler(tab.type)?.icon"
              aria-hidden="true"
            />
            <span class="editor-tab-name">{{ tab.fileName }}</span>
            <span v-if="tab.saving || tab.formatting" class="spinner-border spinner-border-sm editor-tab-spinner" aria-hidden="true" />
            <span
              v-else
              class="tab-close"
              role="button"
              tabindex="0"
              :aria-label="`Close ${tab.fileName}`"
              @click.stop="requestClose(tab)"
              @keydown.enter.stop="requestClose(tab)"
              @keydown.space.prevent.stop="requestClose(tab)"
            >
              <i class="mdi mdi-close" aria-hidden="true" />
            </span>
          </button>
        </div>

        <div v-if="activeEditableTab" class="editor-actions" aria-label="Editor actions">
          <span
            v-if="activeEditableTab"
            class="editor-change-status"
            :class="{
              'is-dirty': activeEditableTab.dirty && !activeEditableTab.saveError,
              'is-error': activeEditableTab.saveError,
            }"
          >{{ editorStatus }}</span>
          <button
            v-if="activeTextTab"
            class="btn btn-sm toolbar-button toolbar-command editor-history-button"
            type="button"
            title="Undo (Cmd/Ctrl+Z)"
            aria-label="Undo"
            :disabled="!canUndo"
            @click="undo"
          >
            <i class="mdi mdi-undo" aria-hidden="true" />
          </button>
          <button
            v-if="activeTextTab"
            class="btn btn-sm toolbar-button toolbar-command editor-history-button"
            type="button"
            title="Redo (Shift+Cmd/Ctrl+Z)"
            aria-label="Redo"
            :disabled="!canRedo"
            @click="redo"
          >
            <i class="mdi mdi-redo" aria-hidden="true" />
          </button>
          <button
            v-if="activeTextTab"
            class="btn btn-sm toolbar-button toolbar-command editor-history-button"
            type="button"
            title="Revert to the last saved version"
            aria-label="Revert to saved"
            :disabled="!canRevert"
            @click="requestRevert"
          >
            <i class="mdi mdi-refresh" aria-hidden="true" />
          </button>
          <button
            class="btn btn-sm toolbar-button toolbar-command"
            type="button"
            title="Save As"
            :disabled="activeEditableTab.loading || activeEditableTab.saving || activeEditableTab.formatting"
            @click="requestSaveAs()"
          >
            <i class="mdi mdi-content-save-move-outline" aria-hidden="true" />
            Save As
          </button>
          <button
            class="btn btn-sm toolbar-button toolbar-command editor-save-button"
            type="button"
            title="Save (Cmd/Ctrl+S)"
            :disabled="!canSave"
            @click="saveActiveTab"
          >
            <span v-if="activeEditableTab?.saving" class="spinner-border spinner-border-sm editor-tab-spinner" aria-hidden="true" />
            <i v-else class="mdi mdi-content-save-outline" aria-hidden="true" />
            Save
          </button>
        </div>
      </div>

      <div v-if="activeTab?.loading" class="editor-message">
        <span class="spinner-border spinner-border-sm" aria-hidden="true" />
        Opening {{ activeTab.fileName }}…
      </div>
      <div v-else-if="activeTab?.error" class="editor-message text-danger" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        <span>{{ activeTab.error.message }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="requestClose(activeTab)">Close tab</button>
      </div>
      <div v-if="!activeTab" class="editor-message">
        <i class="mdi mdi-file-document-edit-outline" aria-hidden="true" />
        Double-click a supported file to open it.
      </div>
      <div v-if="activeEditableTab?.saveError && !activeEditableTab.loading && !activeEditableTab.error" class="editor-save-error" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        {{ activeEditableTab.saveError.message }}
      </div>
      <MonacoEditor
        ref="monacoEditor"
        v-show="Boolean(activeTextTab) && !activeTextTab.loading && !activeTextTab.error"
        :active-tab="activeTextTab"
        :tabs="textTabs"
        :visible="visible && Boolean(activeTextTab) && !activeTextTab.loading && !activeTextTab.error"
        @change="updateContent"
        @history-state="updateHistoryState"
        @status-change="updateEditorPosition"
        @activate-tab="activateTab"
      />
      <component
        :is="getDocumentHandler(tab.type).component"
        v-for="tab in specializedTabs"
        v-show="tab.id === activeTab?.id"
        :key="tab.id"
        :tab="tab"
        :visible="visible && tab.id === activeTab?.id"
        @save="saveActiveTab"
      />
      <PdfViewer
        v-for="tab in pdfTabs"
        :ref="(element) => setPdfViewerRef(element, tab.id)"
        v-show="tab.id === activeTab?.id"
        :key="tab.id"
        :tab="tab"
        :visible="visible && tab.id === activeTab?.id"
        @state-change="updatePdfState"
        @prepare-retry="retryPdfTab"
      />
      <div v-if="activeTabReady" class="editor-statusbar" aria-label="Editor status">
        <span class="editor-statusbar-item" :title="`${activeEditorPosition.errors || 0} errors, ${activeEditorPosition.warnings || 0} warnings in this document`" aria-label="Document diagnostics">
          <i class="mdi mdi-close-circle-outline" aria-hidden="true" /> {{ activeEditorPosition.errors || 0 }}
          <i class="mdi mdi-alert-outline ms-1" aria-hidden="true" /> {{ activeEditorPosition.warnings || 0 }}
        </span>
        <span class="editor-statusbar-item">Line {{ activeEditorPosition.line }}, Col {{ activeEditorPosition.column }}</span>
        <button
          ref="indentationButton"
          class="editor-statusbar-button"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="indentationMenuOpen"
          title="Indentation settings"
          @click="indentationMenuOpen = !indentationMenuOpen"
          @keydown="handleIndentationKeydown"
        >{{ indentationLabel }}</button>
        <span class="editor-statusbar-item">{{ activeEditorPosition.eol }}</span>
        <span class="editor-statusbar-item" title="Text files are read and saved as UTF-8">UTF-8</span>
        <button v-if="settings.editor.formatting.enabled !== false && getFormattingParser(activeTextTab.fileName)" class="compact-button" type="button"
          :disabled="activeTextTab.saving || activeTextTab.formatting"
          :title="`Format Document (Option/Alt+Shift+F). Format on save: ${settings.editor.formatting.formatOnSave ? 'On' : 'Off'}`"
          @click="monacoEditor?.formatDocument()">Prettier</button>
      </div>
      <div
        v-if="activeTabReady && indentationMenuOpen"
        ref="indentationMenu"
        class="dropdown-menu show editor-indentation-menu shadow"
        role="menu"
        aria-label="Indentation settings"
        @keydown="handleIndentationKeydown"
      >
        <h2 class="dropdown-header">Indentation</h2>
        <button class="dropdown-item" type="button" role="menuitemradio" :aria-checked="activeEditorPosition.insertSpaces" @click="setIndentation({ insertSpaces: true })"><i class="mdi" :class="activeEditorPosition.insertSpaces ? 'mdi-check' : 'mdi-blank'" aria-hidden="true" /> Use spaces</button>
        <button class="dropdown-item" type="button" role="menuitemradio" :aria-checked="!activeEditorPosition.insertSpaces" @click="setIndentation({ insertSpaces: false })"><i class="mdi" :class="!activeEditorPosition.insertSpaces ? 'mdi-check' : 'mdi-blank'" aria-hidden="true" /> Use tabs</button>
        <div class="dropdown-divider" />
        <h2 class="dropdown-header">Tab size</h2>
        <div class="editor-indentation-sizes">
          <button v-for="size in 8" :key="size" class="dropdown-item" type="button" role="menuitemradio" :aria-checked="activeEditorPosition.tabSize === size" @click="setIndentation({ tabSize: size, indentSize: 'tabSize' })"><i class="mdi" :class="activeEditorPosition.tabSize === size ? 'mdi-check' : 'mdi-blank'" aria-hidden="true" /> {{ size }}</button>
        </div>
        <div class="dropdown-divider" />
        <button class="dropdown-item" type="button" role="menuitem" @click="detectIndentation"><i class="mdi mdi-auto-fix" aria-hidden="true" /> Detect from content</button>
      </div>
    </section>

    <UnsavedChangesModal
      :open="Boolean(pendingClose)"
      :tab="pendingClose"
      :busy="closeBusy"
      :error="closeError"
      @save="saveAndClose"
      @discard="discardAndClose"
      @cancel="cancelClose"
      @closed="startSaveAsAfterClose"
    />

    <SaveAsModal
      :open="Boolean(saveAsTabId)"
      :tab="tabs.find((tab) => tab.id === saveAsTabId)"
      :busy="saveAsBusy"
      :error="saveAsError"
      @save="saveAs"
      @cancel="cancelSaveAs"
    />

    <RevertChangesModal
      :open="Boolean(pendingRevert)"
      :tab="pendingRevert"
      @confirm="confirmRevert"
      @cancel="cancelRevert"
    />
  </div>
</template>
