<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { connection } from '../api/connection.js'
import { useEditorWorkspace } from '../composables/useEditorWorkspace.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { useLayout } from '../composables/useLayout.js'
import { useMediaViewer } from '../composables/useMediaViewer.js'
import { useSettings } from '../composables/useSettings.js'
import {
  getEntryOpenAction,
  getFileOpenType,
  isMediaOpenType,
  isWorkspaceDocumentType,
} from '../utils/fileTypes.js'
import AudioPlayerBar from './AudioPlayerBar.vue'
import CreateEntryModal from './CreateEntryModal.vue'
import FilePanel from './FilePanel.vue'
import FileOperationConfirmModal from './FileOperationConfirmModal.vue'
import FileEntryContextMenu from './FileEntryContextMenu.vue'
import FileOperationMenu from './FileOperationMenu.vue'
import MediaViewerModal from './MediaViewerModal.vue'
import SettingsModal from './SettingsModal.vue'
import Splitter from './Splitter.vue'
import TerminalPanel from './TerminalPanel.vue'
import Toolbar from './Toolbar.vue'

const EditorWorkspace = defineAsyncComponent(() => import('./EditorWorkspace.vue'))

const { layout, toggleLeft, toggleRight, toggleTerminal, setLeftRatio, setTerminalHeight } =
  useLayout()
const { settings, loadSettings } = useSettings()
const { tabs: editorTabs, openFile: openEditorFile } = useEditorWorkspace()
const {
  copyEntry,
  moveEntry,
  createSymbolicLink,
  deleteEntry,
  createEntry,
} = useFileOperations()
const {
  activeAudio,
  viewer,
  currentViewerMedia,
  viewerPosition,
  viewerCount,
  openMedia,
  closeAudio,
  closeViewer,
  showPrevious,
  showNext,
  retryMedia,
  syncAfterFileOperation,
} = useMediaViewer()
const filesContainer = ref(null)
const leftPanel = ref(null)
const rightPanel = ref(null)
const workspace = ref(null)
const workspaceMode = ref('files')
const activePanel = ref('left')
const connected = ref(connection.isConnected())
const settingsOpen = ref(false)
const createRequest = ref(null)
const createBusy = ref(false)
const createError = ref('')
const openCreate = (kind) => {
  if (!commandAvailability.value.create) return
  createError.value = ''
  createRequest.value = { kind, directory: panelStates[activePanel.value].currentDirectory.path }
}
const submitCreate = async (name) => {
  if (!createRequest.value || createBusy.value) return
  createBusy.value = true
  createError.value = ''
  try {
    const { kind, directory } = createRequest.value
    const response = await createEntry(kind, directory, name)
    if (response.ok) createRequest.value = null
    else createError.value = response.error.message
  } catch (error) {
    createError.value = error.message || 'Unable to create this item'
  } finally { createBusy.value = false }
}
const filesystemRevision = ref(0)
const dropRequest = ref(null)
const operationBusy = ref(false)
const activeOperation = ref('')
const operationError = ref('')
const confirmationRequest = ref(null)
const confirmationBusy = ref(false)
const confirmationError = ref('')
const entryContextRequest = ref(null)
const panelStates = reactive({
  left: {
    currentDirectory: null,
    selected: null,
    canOperateSelected: false,
  },
  right: {
    currentDirectory: null,
    selected: null,
    canOperateSelected: false,
  },
})
let unsubscribeConnection = null

const bothPanelsVisible = computed(() => layout.leftVisible && layout.rightVisible)
const terminalStyle = computed(() =>
  layout.terminalVisible ? { height: `${layout.terminalHeight}px` } : { height: '31px' },
)
const leftPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `calc(${layout.leftRatio}% - 3px)`, flex: '0 0 auto' }
})
const rightPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `calc(${100 - layout.leftRatio}% - 3px)`, flex: '0 0 auto' }
})
const commandAvailability = computed(() => {
  const source = panelStates[activePanel.value]
  const targetSide = activePanel.value === 'left' ? 'right' : 'left'
  const activePanelVisible =
    activePanel.value === 'left' ? layout.leftVisible : layout.rightVisible
  const targetPanelVisible =
    targetSide === 'left' ? layout.leftVisible : layout.rightVisible
  const interactionBlocked = Boolean(
    !connected.value ||
      settingsOpen.value ||
      createRequest.value ||
      dropRequest.value ||
      confirmationRequest.value ||
      entryContextRequest.value ||
      viewer.value ||
      operationBusy.value ||
      confirmationBusy.value ||
      workspaceMode.value !== 'files',
  )
  const canUseSource = Boolean(
    activePanelVisible && source?.selected && source.canOperateSelected,
  )
  const canTransfer = Boolean(
    canUseSource &&
      targetPanelVisible &&
      panelStates[targetSide]?.currentDirectory?.isDirectory,
  )

  return {
    create: Boolean(activePanelVisible && source?.currentDirectory?.isDirectory && !interactionBlocked),
    copy: canTransfer && !interactionBlocked,
    move: canTransfer && !interactionBlocked,
    delete: canUseSource && !interactionBlocked,
  }
})
const editorAvailable = computed(() => editorTabs.value.length > 0)
const entryContextOpenAction = computed(() =>
  getEntryOpenAction(
    entryContextRequest.value?.node,
    settings.value.editor.editableFiles,
  ),
)

const activate = (side) => {
  activePanel.value = side
}

const hideLeft = () => {
  layout.leftVisible = false

  if (layout.rightVisible) {
    activePanel.value = 'right'
  }
}

const hideRight = () => {
  layout.rightVisible = false

  if (layout.leftVisible) {
    activePanel.value = 'left'
  }
}

const toggleLeftPanel = () => {
  toggleLeft()

  if (layout.leftVisible) {
    activePanel.value = 'left'
  } else if (layout.rightVisible) {
    activePanel.value = 'right'
  }
}

const toggleRightPanel = () => {
  toggleRight()

  if (layout.rightVisible) {
    activePanel.value = 'right'
  } else if (layout.leftVisible) {
    activePanel.value = 'left'
  }
}

const resizePanels = (delta) => {
  const width = filesContainer.value?.clientWidth

  if (!width) {
    return
  }

  setLeftRatio(layout.leftRatio + (delta / width) * 100)
}

const resizeTerminal = (delta) => {
  const availableHeight = workspace.value?.clientHeight || window.innerHeight
  setTerminalHeight(layout.terminalHeight - delta, availableHeight)
}

const clampTerminalToViewport = () => {
  const availableHeight = workspace.value?.clientHeight || window.innerHeight
  setTerminalHeight(layout.terminalHeight, availableHeight)
}

const handleConnect = () => {
  connected.value = true
}

const handleDisconnect = () => {
  connected.value = false
}

const updatePanelState = (state) => {
  if (!state || !panelStates[state.side]) {
    return
  }

  panelStates[state.side] = {
    currentDirectory: state.currentDirectory,
    selected: state.selected,
    canOperateSelected: state.canOperateSelected,
  }
}

const openFile = (context) => {
  const type = getFileOpenType(
    context?.node?.name,
    settings.value.editor.editableFiles,
  )

  if (isMediaOpenType(type)) {
    openMedia(context)
    return
  }

  if (!isWorkspaceDocumentType(type)) {
    return
  }

  workspaceMode.value = 'editor'
  openEditorFile({ ...context, type })
}

const showFiles = () => {
  workspaceMode.value = 'files'
}

const showEditor = () => {
  if (editorAvailable.value) {
    workspaceMode.value = 'editor'
  }
}

const runFileOperation = (action, source, targetDirectory) => {
  if (action === 'copy') {
    return copyEntry(source, targetDirectory)
  }

  if (action === 'move') {
    return moveEntry(source, targetDirectory)
  }

  if (action === 'link') {
    return createSymbolicLink(source, targetDirectory)
  }

  if (action === 'delete') {
    return deleteEntry(source)
  }

  return Promise.resolve({
    ok: false,
    error: { code: 'EINVAL', message: 'Unknown file operation' },
  })
}

const openFileOperationMenu = (requestDetails) => {
  entryContextRequest.value = null
  activePanel.value = requestDetails.targetPanel
  dropRequest.value = requestDetails
  operationBusy.value = false
  activeOperation.value = ''
  operationError.value = ''
}

const openEntryContextMenu = (requestDetails) => {
  activePanel.value = requestDetails.sourcePane
  entryContextRequest.value = requestDetails
}

const closeEntryContextMenu = () => {
  entryContextRequest.value = null
}

const executeEntryContextOpen = () => {
  const requestDetails = entryContextRequest.value

  if (!requestDetails || !entryContextOpenAction.value) {
    return
  }

  entryContextRequest.value = null
  const panel = requestDetails.sourcePane === 'left' ? leftPanel.value : rightPanel.value
  panel?.openNode(requestDetails)
}

const executeEntryContextDelete = () => {
  const requestDetails = entryContextRequest.value

  if (!requestDetails) {
    return
  }

  entryContextRequest.value = null
  activePanel.value = requestDetails.sourcePane
  confirmationError.value = ''
  confirmationRequest.value = {
    action: 'delete',
    source: requestDetails.node,
    sourcePanel: requestDetails.sourcePane,
    targetDirectory: null,
    targetPanel: null,
  }
}

const closeFileOperationMenu = () => {
  if (operationBusy.value) {
    return
  }

  dropRequest.value = null
  activeOperation.value = ''
  operationError.value = ''
}

const executeFileOperation = async (action) => {
  if (!dropRequest.value || operationBusy.value) {
    return
  }

  const requestDetails = {
    ...dropRequest.value,
    action,
  }
  operationBusy.value = true
  activeOperation.value = action
  operationError.value = ''
  const response = await runFileOperation(
    action,
    dropRequest.value.source,
    dropRequest.value.target,
  )
  operationBusy.value = false

  if (!response?.ok) {
    activeOperation.value = ''
    operationError.value = response?.error?.message || 'The file operation failed'
    return
  }

  syncAfterFileOperation(requestDetails, response)
  dropRequest.value = null
  activeOperation.value = ''
  filesystemRevision.value += 1
}

const openCommanderConfirmation = (action) => {
  if (!commandAvailability.value[action]) {
    return
  }

  const sourcePanel = panelStates[activePanel.value]
  const targetSide = activePanel.value === 'left' ? 'right' : 'left'

  entryContextRequest.value = null
  confirmationError.value = ''
  confirmationRequest.value = {
    action,
    source: sourcePanel.selected,
    sourcePanel: activePanel.value,
    targetDirectory:
      action === 'delete' ? null : panelStates[targetSide].currentDirectory,
    targetPanel: action === 'delete' ? null : targetSide,
  }
}

const closeCommanderConfirmation = () => {
  if (confirmationBusy.value) {
    return
  }

  confirmationRequest.value = null
  confirmationError.value = ''
}

const executeCommanderOperation = async () => {
  if (!confirmationRequest.value || confirmationBusy.value) {
    return
  }

  const requestDetails = confirmationRequest.value
  confirmationBusy.value = true
  confirmationError.value = ''
  const response = await runFileOperation(
    requestDetails.action,
    requestDetails.source,
    requestDetails.targetDirectory,
  )
  confirmationBusy.value = false

  if (!response?.ok) {
    confirmationError.value =
      response?.error?.message || 'The file operation failed'
    return
  }

  syncAfterFileOperation(requestDetails, response)
  confirmationRequest.value = null
  filesystemRevision.value += 1
}

const handleCommanderKeydown = (event) => {
  if (workspaceMode.value !== 'files' || event.target.closest?.('input, textarea, [contenteditable="true"]')) {
    return
  }

  const actionByKey = {
    F5: 'copy',
    F6: 'move',
    F8: 'delete',
  }
  const action = actionByKey[event.key]

  if (!action || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return
  }

  event.preventDefault()
  openCommanderConfirmation(action)
}

onMounted(() => {
  loadSettings()
  unsubscribeConnection = connection.onStatusChange((isConnected) => {
    if (isConnected) {
      handleConnect()
    } else {
      handleDisconnect()
    }
  })
  window.addEventListener('resize', clampTerminalToViewport)
  window.addEventListener('keydown', handleCommanderKeydown)
  clampTerminalToViewport()
})

onBeforeUnmount(() => {
  unsubscribeConnection?.()
  window.removeEventListener('resize', clampTerminalToViewport)
  window.removeEventListener('keydown', handleCommanderKeydown)
})
</script>

<template>
  <main class="app-shell">
    <Toolbar
      :layout="layout"
      :active-panel="activePanel"
      :connected="connected"
      :command-availability="commandAvailability"
      :workspace-mode="workspaceMode"
      :editor-available="editorAvailable"
      @toggle-left="toggleLeftPanel"
      @toggle-right="toggleRightPanel"
      @toggle-terminal="toggleTerminal"
      @open-settings="settingsOpen = true"
      @copy="openCommanderConfirmation('copy')"
      @move="openCommanderConfirmation('move')"
      @delete="openCommanderConfirmation('delete')"
      @create="openCreate"
      @show-files="showFiles"
      @show-editor="showEditor"
    />

    <AudioPlayerBar
      v-if="activeAudio"
      :media="activeAudio"
      @close="closeAudio"
      @retry="retryMedia"
    />

    <div ref="workspace" class="workspace">
      <div v-show="workspaceMode === 'files'" ref="filesContainer" class="files-container">
        <FilePanel
          ref="leftPanel"
          v-if="layout.leftVisible"
          side="left"
          :active="activePanel === 'left'"
          :filesystem-revision="filesystemRevision"
          :style="leftPanelStyle"
          @activate="activate('left')"
          @collapse="hideLeft"
          @drop-request="openFileOperationMenu"
          @context-menu="openEntryContextMenu"
          @open-file="openFile"
          @state-change="updatePanelState"
        />

        <Splitter
          v-if="bothPanelsVisible"
          orientation="vertical"
          @resize="resizePanels"
        />

        <FilePanel
          ref="rightPanel"
          v-if="layout.rightVisible"
          side="right"
          :active="activePanel === 'right'"
          :filesystem-revision="filesystemRevision"
          :style="rightPanelStyle"
          @activate="activate('right')"
          @collapse="hideRight"
          @drop-request="openFileOperationMenu"
          @context-menu="openEntryContextMenu"
          @open-file="openFile"
          @state-change="updatePanelState"
        />

        <div v-if="!layout.leftVisible && !layout.rightVisible" class="no-panels-message">
          <i class="mdi mdi-folder-open-outline" aria-hidden="true" />
          <span>Both file panels are hidden.</span>
          <button class="btn btn-sm btn-outline-light" type="button" @click="toggleLeftPanel">
            Show left panel
          </button>
        </div>
      </div>

      <EditorWorkspace
        v-if="editorAvailable"
        v-show="workspaceMode === 'editor'"
        :visible="workspaceMode === 'editor'"
        @show-files="showFiles"
        @empty="showFiles"
        @open-file="openFile"
      />

      <Splitter
        v-if="layout.terminalVisible"
        orientation="horizontal"
        @resize="resizeTerminal"
      />

      <TerminalPanel
        :visible="layout.terminalVisible"
        :style="terminalStyle"
        @toggle="toggleTerminal"
      />
    </div>

    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
    <CreateEntryModal :request="createRequest" :busy="createBusy" :error="createError" @confirm="submitCreate" @cancel="!createBusy && (createRequest = null)" />
    <MediaViewerModal
      :open="Boolean(viewer)"
      :media="currentViewerMedia"
      :kind="viewer?.kind || ''"
      :position="viewerPosition"
      :total="viewerCount"
      @close="closeViewer"
      @previous="showPrevious"
      @next="showNext"
      @retry="retryMedia"
    />
    <FileOperationConfirmModal
      :open="Boolean(confirmationRequest)"
      :request="confirmationRequest"
      :busy="confirmationBusy"
      :error="confirmationError"
      @confirm="executeCommanderOperation"
      @cancel="closeCommanderConfirmation"
    />
    <FileOperationMenu
      v-if="dropRequest"
      :key="`${dropRequest.source.path}:${dropRequest.target.path}:${dropRequest.x}:${dropRequest.y}`"
      :request="dropRequest"
      :busy="operationBusy"
      :active-action="activeOperation"
      :error="operationError"
      @select="executeFileOperation"
      @cancel="closeFileOperationMenu"
    />
    <FileEntryContextMenu
      v-if="entryContextRequest"
      :key="`${entryContextRequest.node.path}:${entryContextRequest.x}:${entryContextRequest.y}`"
      :request="entryContextRequest"
      :open-action="entryContextOpenAction"
      @open="executeEntryContextOpen"
      @delete="executeEntryContextDelete"
      @cancel="closeEntryContextMenu"
    />
  </main>
</template>
