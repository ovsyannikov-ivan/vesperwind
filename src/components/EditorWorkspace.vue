<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorLayout } from '../composables/useEditorLayout.js'
import { useEditorWorkspace } from '../composables/useEditorWorkspace.js'
import {
  DOCUMENT_FIND_INTENTS,
  getDocumentFindIntent,
} from '../utils/documentFindShortcuts.js'
import EditorTree from './EditorTree.vue'
import MonacoEditor from './MonacoEditor.vue'
import PdfViewer from './PdfViewer.vue'
import RevertChangesModal from './RevertChangesModal.vue'
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
const pdfViewerRefs = new Map()
const pendingClose = ref(null)
const pendingRevert = ref(null)
const closeBusy = ref(false)
const closeError = ref('')
const historyState = ref({ tabId: null, canUndo: false, canRedo: false })
const { editorLayout, setTreeWidth } = useEditorLayout()
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
const pdfTabs = computed(() => tabs.value.filter((tab) => tab.type === 'pdf'))
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
    activeTabReady.value &&
      activeTextTab.value.dirty &&
      !activeTextTab.value.saving,
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
  if (!activeTextTab.value) {
    return ''
  }

  if (activeTextTab.value.saving) {
    return 'Saving…'
  }

  if (activeTextTab.value.saveError) {
    return 'Save failed'
  }

  return activeTextTab.value.dirty ? 'Unsaved' : 'Saved'
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
  if (tab.type === 'text' && tab.dirty) {
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
  closeBusy.value = true
  closeError.value = ''
  const response = await saveTab(tabId)
  closeBusy.value = false

  if (!response?.ok) {
    closeError.value = response?.error?.message || 'Unable to save this file'
    return
  }

  finishClose(tabId)
}

const updateHistoryState = (state) => {
  historyState.value = state
}

const saveActiveTab = () => {
  if (!canSave.value) {
    return
  }

  saveTab(activeTextTab.value.id)
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

  if (activeTab.value?.type === 'pdf') {
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
      activeTab.value?.type === 'pdf' &&
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
    saveActiveTab()
  }
}

const handleBeforeUnload = (event) => {
  if (!tabs.value.some((tab) => tab.type === 'text' && tab.dirty)) {
    return
  }

  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  window.addEventListener('keydown', handleEditorKeydown, true)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEditorKeydown, true)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <div ref="workspaceElement" class="editor-workspace">
    <aside class="editor-tree-pane" :style="treeStyle">
      <div class="editor-tree-toolbar">
        <button class="btn btn-sm toolbar-button" type="button" title="Return to file panels" @click="$emit('show-files')">
          <i class="mdi mdi-arrow-left" aria-hidden="true" />
          Files
        </button>
        <span v-if="activeTab" class="editor-source-pane">{{ activeTab.sourcePane }}</span>
      </div>

      <template v-for="context in treeContexts" :key="context.key">
        <EditorTree
          v-show="context.key === activeContextKey"
          :context="context"
          :active-file-path="context.key === activeContextKey ? activeTab?.filePath : ''"
          @open-file="$emit('open-file', $event)"
        />
      </template>
    </aside>

    <Splitter orientation="vertical" @resize="resizeTree" />

    <section class="editor-main">
      <div class="editor-header">
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
              :class="tab.type === 'pdf' ? 'mdi-file-pdf-box' : 'mdi-file-code-outline'"
              aria-hidden="true"
            />
            <span class="editor-tab-name">{{ tab.fileName }}</span>
            <span v-if="tab.saving" class="spinner-border spinner-border-sm editor-tab-spinner" aria-hidden="true" />
            <span
              v-else
              class="editor-tab-close"
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

        <div v-if="activeTextTab" class="editor-actions" aria-label="Editor actions">
          <span
            v-if="activeTextTab"
            class="editor-change-status"
            :class="{
              'is-dirty': activeTextTab.dirty && !activeTextTab.saveError,
              'is-error': activeTextTab.saveError,
            }"
          >{{ editorStatus }}</span>
          <button
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
            class="btn btn-sm toolbar-button toolbar-command editor-save-button"
            type="button"
            title="Save (Cmd/Ctrl+S)"
            :disabled="!canSave"
            @click="saveActiveTab"
          >
            <span v-if="activeTextTab?.saving" class="spinner-border spinner-border-sm editor-tab-spinner" aria-hidden="true" />
            <i v-else class="mdi mdi-content-save-outline" aria-hidden="true" />
            Save
          </button>
        </div>
      </div>

      <div v-if="activeTextTab?.loading" class="editor-message">
        <span class="spinner-border spinner-border-sm" aria-hidden="true" />
        Opening {{ activeTextTab.fileName }}…
      </div>
      <div v-else-if="activeTextTab?.error" class="editor-message text-danger" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        <span>{{ activeTextTab.error.message }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="requestClose(activeTextTab)">Close tab</button>
      </div>
      <div v-if="!activeTab" class="editor-message">
        <i class="mdi mdi-file-document-edit-outline" aria-hidden="true" />
        Double-click a text file to open it.
      </div>
      <div v-if="activeTextTab?.saveError && !activeTextTab.loading && !activeTextTab.error" class="editor-save-error" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        {{ activeTextTab.saveError.message }}
      </div>
      <MonacoEditor
        ref="monacoEditor"
        v-show="Boolean(activeTextTab) && !activeTextTab.loading && !activeTextTab.error"
        :active-tab="activeTextTab"
        :tabs="textTabs"
        :visible="visible && Boolean(activeTextTab) && !activeTextTab.loading && !activeTextTab.error"
        @change="updateContent"
        @history-state="updateHistoryState"
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
    </section>

    <UnsavedChangesModal
      :open="Boolean(pendingClose)"
      :tab="pendingClose"
      :busy="closeBusy"
      :error="closeError"
      @save="saveAndClose"
      @discard="discardAndClose"
      @cancel="cancelClose"
    />

    <RevertChangesModal
      :open="Boolean(pendingRevert)"
      :tab="pendingRevert"
      @confirm="confirmRevert"
      @cancel="cancelRevert"
    />
  </div>
</template>
