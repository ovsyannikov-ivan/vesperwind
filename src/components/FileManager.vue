<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { connection } from '../api/connection.js'
import { useEditorWorkspace } from '../composables/useEditorWorkspace.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { useLayout } from '../composables/useLayout.js'
import { useMediaViewer } from '../composables/useMediaViewer.js'
import { useSettings } from '../composables/useSettings.js'
import {
  getFileOpenType,
  isMediaOpenType,
  isWorkspaceDocumentType,
} from '../utils/fileTypes.js'
import AudioPlayerBar from './AudioPlayerBar.vue'
import FilePanel from './FilePanel.vue'
import FileOperationConfirmModal from './FileOperationConfirmModal.vue'
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
  syncAfterFileOperation,
} = useMediaViewer()
const filesContainer = ref(null)
const workspace = ref(null)
const workspaceMode = ref('files')
const activePanel = ref('left')
const connected = ref(connection.isConnected())
const settingsOpen = ref(false)
const filesystemRevision = ref(0)
const dropRequest = ref(null)
const operationBusy = ref(false)
const activeOperation = ref('')
const operationError = ref('')
const confirmationRequest = ref(null)
const confirmationBusy = ref(false)
const confirmationError = ref('')
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
      dropRequest.value ||
      confirmationRequest.value ||
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
    copy: canTransfer && !interactionBlocked,
    move: canTransfer && !interactionBlocked,
    delete: canUseSource && !interactionBlocked,
  }
})
const editorAvailable = computed(() => editorTabs.value.length > 0)

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

const runFileOperation = (action, sourcePath, targetDirectory) => {
  if (action === 'copy') {
    return copyEntry(sourcePath, targetDirectory)
  }

  if (action === 'move') {
    return moveEntry(sourcePath, targetDirectory)
  }

  if (action === 'link') {
    return createSymbolicLink(sourcePath, targetDirectory)
  }

  if (action === 'delete') {
    return deleteEntry(sourcePath)
  }

  return Promise.resolve({
    ok: false,
    error: { code: 'EINVAL', message: 'Unknown file operation' },
  })
}

const openFileOperationMenu = (requestDetails) => {
  activePanel.value = requestDetails.targetPanel
  dropRequest.value = requestDetails
  operationBusy.value = false
  activeOperation.value = ''
  operationError.value = ''
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
    dropRequest.value.source.path,
    dropRequest.value.target.path,
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
    requestDetails.source.path,
    requestDetails.targetDirectory?.path,
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
  if (workspaceMode.value !== 'files') {
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
      @show-files="showFiles"
      @show-editor="showEditor"
    />

    <AudioPlayerBar
      v-if="activeAudio"
      :media="activeAudio"
      @close="closeAudio"
    />

    <div ref="workspace" class="workspace">
      <div v-show="workspaceMode === 'files'" ref="filesContainer" class="files-container">
        <FilePanel
          v-if="layout.leftVisible"
          side="left"
          :active="activePanel === 'left'"
          :filesystem-revision="filesystemRevision"
          :style="leftPanelStyle"
          @activate="activate('left')"
          @collapse="hideLeft"
          @drop-request="openFileOperationMenu"
          @open-file="openFile"
          @state-change="updatePanelState"
        />

        <Splitter
          v-if="bothPanelsVisible"
          orientation="vertical"
          @resize="resizePanels"
        />

        <FilePanel
          v-if="layout.rightVisible"
          side="right"
          :active="activePanel === 'right'"
          :filesystem-revision="filesystemRevision"
          :style="rightPanelStyle"
          @activate="activate('right')"
          @collapse="hideRight"
          @drop-request="openFileOperationMenu"
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
    <MediaViewerModal
      :open="Boolean(viewer)"
      :media="currentViewerMedia"
      :kind="viewer?.kind || ''"
      :position="viewerPosition"
      :total="viewerCount"
      @close="closeViewer"
      @previous="showPrevious"
      @next="showNext"
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
  </main>
</template>
