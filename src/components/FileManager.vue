<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { settleFileOperation } from '../composables/fileOperationLifecycle.js'
import { isComputerPath } from '../../shared/localFilesystem.js'
import { connection } from '../api/connection.js'
import { useEditorWorkspace } from '../composables/useEditorWorkspace.js'
import { openTextDocument } from '../editor/openTextDocument.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { useLayout } from '../composables/useLayout.js'
import { useMediaViewer } from '../composables/useMediaViewer.js'
import { useQuickLook } from '../composables/useQuickLook.js'
import { canOpenQuickLook } from '../utils/quickLookKeyboard.js'
import { createPlaybackCoordinator } from '../player/playbackCoordination.js'
import QuickLookModal from './QuickLookModal.vue'
import PropertiesModal from './PropertiesModal.vue'
import { useProperties } from '../composables/useProperties.js'
import { canOpenProperties } from '../utils/propertiesKeyboard.js'
import { useSettings } from '../composables/useSettings.js'
import {
  getEntryOpenAction,
  getFileOpenType,
  isMediaOpenType,
  isWorkspaceDocumentType,
} from '../utils/fileTypes.js'
import {
  crossedPanelSwapThreshold,
  oppositePanelSide,
  swapPanelPair,
} from '../utils/panelSwap.js'
import { transferSources } from '../utils/fileSelection.js'
import AudioPlayerBar from './AudioPlayerBar.vue'
import PlaylistCommandModal from './PlaylistCommandModal.vue'
import { media as mediaApi } from '../api/media.js'
import { filesystem } from '../api/filesystem.js'
import { createSourceOpener } from '../player/openMediaSource.js'
import { normalizeMediaSource } from '../player/mediaSource.js'
import { isPlaylistFile, exportM3u, playlistParentPath } from '../player/m3u.js'
import { importPlaylist, playlistDestination } from '../player/playlistFiles.js'
import AudioPlaylist from './AudioPlaylist.vue'
import { useAudioPlayer } from '../composables/useAudioPlayer.js'
import { verticalWorkspaceSizes } from '../player/workspaceSizing.js'
import CreateEntryModal from './CreateEntryModal.vue'
import FilePanel from './FilePanel.vue'
import FileOperationConfirmModal from './FileOperationConfirmModal.vue'
import FileEntryContextMenu from './FileEntryContextMenu.vue'
import { desktop } from '../api/desktop.js'
import { onNativeOpenSettings, installNativeEditHistory } from '../api/nativeAppMenu.js'
import FileOperationMenu from './FileOperationMenu.vue'
import MediaViewerModal from './MediaViewerModal.vue'
import SettingsModal from './SettingsModal.vue'
import RemoteConnectionsModal from './RemoteConnectionsModal.vue'
import Splitter from './Splitter.vue'
import TerminalPanel from './TerminalPanel.vue'
import Toolbar from './Toolbar.vue'
import ArchiveOperationModal from './ArchiveOperationModal.vue'
import { startArchiveOperation } from '../api/archives.js'
import { archiveName, extractionFolderName } from '../../shared/archivePolicy.js'
import { notifyEntryChange } from '../composables/useEntryChanges.js'
import { isAddressShortcut } from '../utils/addressNavigation.js'
import { isFilesystemRootEntry } from '../../shared/localFilesystem.js'
import { runtime } from '../api/runtime.js'
import { diskImages, onShellEvent } from '../api/shellIntegration.js'
import { useFileClipboard } from '../composables/useFileClipboard.js'
import { useNotice } from '../composables/useNotice.js'
import {
  canOfferDiskImage,
  clipboardShortcutLabels,
  fileClipboardShortcut,
  pasteBlockReason,
  planPaste,
} from '../utils/fileClipboard.js'
import { getFilesystemParentPath } from '../utils/filesystemPath.js'
import { activeNativeDrag, endNativeDrag, nativeDropTarget } from '../utils/nativeDragSession.js'

const EditorWorkspace = defineAsyncComponent(() => import('./EditorWorkspace.vue'))

const { layout, toggleLeft, toggleRight, toggleTerminal, setLeftRatio, setTerminalHeight, setAudioPlaylistHeight } =
  useLayout()
const { settings, loadSettings } = useSettings()
const { tabs: editorTabs, openFile: openEditorFile, closeTab: closeEditorTab } = useEditorWorkspace()
const {
  copyEntry,
  moveEntry,
  createSymbolicLink,
  deleteEntry,
  createEntry,
} = useFileOperations()
const audioPlayerBar = ref(null)
const audio = useAudioPlayer({ onStop: () => audioPlayerBar.value?.pause() })
const audioVisible = computed(() => audio.state.visible)
const {
  viewer,
  currentViewerMedia,
  viewerPosition,
  viewerCount,
  openMedia,
  openSource,
  closeViewer,
  showPrevious,
  showNext,
  retryMedia,
  syncAfterFileOperation,
} = useMediaViewer({ audio })
const playback = createPlaybackCoordinator({ pauseBackgroundAudio: () => audioPlayerBar.value?.pause() })
const openCoordinatedMedia = (context, canOpen) => playback.openMedia(context, openMedia, canOpen)
const quickLook = useQuickLook({ openMedia: openCoordinatedMedia, closeMedia: closeViewer, beforePlayback: playback.beforePlayback })
const quickLookPreview = quickLook.preview
const handleViewerClose = () => {
  if (quickLook.current.value) quickLook.close()
  else closeViewer()
}
const filesContainer = ref(null)
const leftPanel = ref(null)
const rightPanel = ref(null)
const workspace = ref(null)
const workspaceMode = ref('files')
const activePanel = ref('left')
const connected = ref(connection.isConnected())
const settingsOpen = ref(false)
const openSettings = () => { settingsOpen.value = true }
let unsubscribeNativeSettings = null
const remoteConnectionsOpen = ref(false)
const panelSlots = reactive({
  left: { id: 'panel-a', providerId: 'local', label: 'Local', viewState: null },
  right: { id: 'panel-b', providerId: 'local', label: 'Local', viewState: null },
})
const createRequest = ref(null)
const createBusy = ref(false)
const createError = ref('')
const openCreate = (kind) => {
  if (!commandAvailability.value.create) return
  createError.value = ''
  createRequest.value = { kind, directory: panelStates[activePanel.value].currentDirectory }
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
const handleRemoteConnected = ({ providerId, profile, targetPanel }) => {
  panelSlots[targetPanel] = {
    ...panelSlots[targetPanel],
    providerId,
    label: profile.name,
  }
  activePanel.value = targetPanel
  filesystemRevision.value += 1
}
const filesystemRevision = ref(0)
const propertiesState = useProperties({ onChanged: () => { filesystemRevision.value++ } })
const dropRequest = ref(null)
const operationBusy = ref(false)
const activeOperation = ref('')
const operationError = ref('')
const confirmationRequest = ref(null)
const confirmationBusy = ref(false)
let operationGeneration = 0
let confirmationGeneration = 0
const confirmationError = ref('')
const entryContextRequest = ref(null)
const entryContextBusy = ref(false)
const entryContextError = ref('')
const panelDrag = ref(null)
const panelSwapTarget = ref(null)
const panelStates = reactive({
  left: {
    currentDirectory: null,
    selected: null,
    selectedEntries: [],
    canOperateSelected: false,
  },
  right: {
    currentDirectory: null,
    selected: null,
    selectedEntries: [],
    canOperateSelected: false,
  },
})
let unsubscribeConnection = null
const archiveRequest = ref(null), archiveBusy = ref(false), archiveCancelling = ref(false)
const archiveError = ref(null), archiveProgress = ref(null)
let archiveJob = null
const openArchive = (action, context = false) => {
  if (archiveBusy.value || archiveRequest.value) return
  const state = panelStates[activePanel.value]
  const sources = context && action === 'extract' ? [entryContextRequest.value?.node] : transferSources(state.selectedEntries)
  if (!sources?.length || sources.some((s) => !s || s.providerId !== 'local')) return
  const other = oppositePanelSide(activePanel.value)
  const otherVisible = other === 'left' ? layout.leftVisible : layout.rightVisible
  const alternate = otherVisible ? panelStates[other].currentDirectory : null
  const target = alternate?.providerId === 'local' && !isComputerPath(alternate.path) ? alternate : state.currentDirectory
  if (!target || target.providerId !== 'local' || isComputerPath(target.path)) return
  archiveError.value = null; archiveProgress.value = null; archiveCancelling.value = false
  archiveRequest.value = { action, sources, target, name: action === 'create' ? `${sources.length === 1 ? sources[0].name : 'Archive'}.zip` : extractionFolderName(sources[0].name) }
  entryContextRequest.value = null
}
const cancelArchive = () => {
  if (archiveBusy.value) { archiveCancelling.value = true; archiveJob?.cancel() }
  else archiveRequest.value = null
}
const submitArchive = ({ name, targetPath }) => {
  if (!archiveRequest.value || archiveBusy.value) return
  archiveBusy.value = true; archiveError.value = null; archiveCancelling.value = false
  const request = { ...archiveRequest.value, name, target: { providerId: 'local', path: targetPath } }
  archiveJob = startArchiveOperation(request, (event) => {
    if (!event.done) { archiveProgress.value = event; return }
    archiveBusy.value = false; archiveCancelling.value = false; archiveJob = null
    if (event.result) { notifyEntryChange({ ok: true, result: event.result }, 'local'); archiveRequest.value = null }
    else if (event.error?.code === 'ECANCELLED') archiveRequest.value = null
    else archiveError.value = event.error
  })
}

const bothPanelsVisible = computed(() => layout.leftVisible && layout.rightVisible)
const workspaceHeight = ref(window.innerHeight - 100)
const playlistVisible = computed(() => audioVisible.value && layout.audioPlaylistExpanded)
const effectiveSizes = computed(() => verticalWorkspaceSizes({ availableHeight: workspaceHeight.value,
  terminalVisible: layout.terminalVisible, playlistVisible: playlistVisible.value,
  terminalHeight: layout.terminalHeight, playlistHeight: layout.audioPlaylistHeight }))
const terminalStyle = computed(() => ({ height: `${effectiveSizes.value.terminal}px`, minHeight: 0 }))
const playlistStyle = computed(() => ({ height: `${effectiveSizes.value.playlist}px` }))

const leftPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `${layout.leftRatio}%`, flex: '0 0 auto' }
})
const rightPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `calc(${100 - layout.leftRatio}% - var(--panel-seam-width))`, flex: '0 0 auto' }
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
      playlistRequest.value ||
      createRequest.value ||
      archiveRequest.value ||
      dropRequest.value ||
      confirmationRequest.value ||
      entryContextRequest.value ||
      viewer.value ||
      quickLook.current.value || propertiesState.current.value ||
      operationBusy.value ||
      confirmationBusy.value ||
      workspaceMode.value !== 'files',
  )
  const canUseSource = Boolean(
    activePanelVisible && source?.selectedEntries?.length && source.canOperateSelected,
  )
  const canTransfer = Boolean(
    canUseSource &&
      targetPanelVisible &&
      panelStates[targetSide]?.currentDirectory?.isDirectory &&
      !isComputerPath(panelStates[targetSide].currentDirectory.path),
  )

  return {
    archiveCreate: canUseSource && !interactionBlocked && source.selectedEntries.every((s) => s.providerId === 'local'),
    archiveExtract: canUseSource && !interactionBlocked && source.selectedEntries.length === 1 &&
      source.selectedEntries[0].providerId === 'local' && !source.selectedEntries[0].isDirectory && archiveName(source.selectedEntries[0].name),
    create: Boolean(activePanelVisible && source?.currentDirectory?.isDirectory &&
      !isComputerPath(source.currentDirectory.path) && !interactionBlocked),
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

const swapPanels = () => {
  const nextSlots = swapPanelPair(panelSlots)
  const nextStates = swapPanelPair(panelStates)
  panelSlots.left = nextSlots.left
  panelSlots.right = nextSlots.right
  panelStates.left = nextStates.left
  panelStates.right = nextStates.right
  activePanel.value = oppositePanelSide(activePanel.value)
}

const clearPanelDrag = () => {
  panelDrag.value = null
  panelSwapTarget.value = null
  document.body.classList.remove('is-swapping-panels')
  window.removeEventListener('pointermove', handlePanelDragMove)
  window.removeEventListener('pointerup', handlePanelDragEnd)
  window.removeEventListener('pointercancel', clearPanelDrag)
  window.removeEventListener('keydown', handlePanelDragKeydown)
}

const targetPanelSideAt = (clientX, clientY) =>
  document
    .elementFromPoint(clientX, clientY)
    ?.closest?.('[data-panel-swap-target]')
    ?.dataset?.panelSwapTarget || null

const handlePanelDragMove = (event) => {
  const drag = panelDrag.value
  if (!drag || event.pointerId !== drag.pointerId) return

  if (!drag.started) {
    if (!crossedPanelSwapThreshold(drag.startX, drag.startY, event.clientX, event.clientY)) {
      return
    }
    drag.started = true
    document.body.classList.add('is-swapping-panels')
  }

  event.preventDefault()
  const targetSide = targetPanelSideAt(event.clientX, event.clientY)
  panelSwapTarget.value = targetSide === oppositePanelSide(drag.side) ? targetSide : null
}

const handlePanelDragEnd = (event) => {
  const drag = panelDrag.value
  if (!drag || event.pointerId !== drag.pointerId) return
  const targetSide = drag.started
    ? targetPanelSideAt(event.clientX, event.clientY)
    : null
  const shouldSwap = targetSide === oppositePanelSide(drag.side)
  clearPanelDrag()
  if (shouldSwap) swapPanels()
}

const handlePanelDragKeydown = (event) => {
  if (event.key === 'Escape') clearPanelDrag()
}

const beginPanelDrag = (candidate) => {
  if (!bothPanelsVisible.value || workspaceMode.value !== 'files') return
  clearPanelDrag()
  panelDrag.value = { ...candidate, started: false }
  window.addEventListener('pointermove', handlePanelDragMove, { passive: false })
  window.addEventListener('pointerup', handlePanelDragEnd)
  window.addEventListener('pointercancel', clearPanelDrag)
  window.addEventListener('keydown', handlePanelDragKeydown)
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

const resizeTerminal = (delta) => setTerminalHeight(effectiveSizes.value.terminal - delta, workspaceHeight.value, playlistVisible.value)
const resizePlaylist = (delta) => setAudioPlaylistHeight(effectiveSizes.value.playlist + delta, workspaceHeight.value, playlistVisible.value)
const clampTerminalToViewport = () => { workspaceHeight.value = workspace.value?.clientHeight || window.innerHeight - 100 }
let workspaceObserver = null
watch(workspace, (element) => {
  workspaceObserver?.disconnect()
  if (element) { workspaceObserver = new ResizeObserver(clampTerminalToViewport); workspaceObserver.observe(element); clampTerminalToViewport() }
})

const handleConnect = () => {
  connected.value = true
}

const handleDisconnect = () => {
  connected.value = false
}

const updatePanelState = (state) => {
  if (!state || !panelStates[state.side] || !state.currentDirectory ||
    panelSlots[state.side].id !== state.panelId) {
    return
  }

  panelStates[state.side] = {
    currentDirectory: state.currentDirectory,
    selected: state.selected,
    selectedEntries: state.selectedEntries,
    canOperateSelected: state.canOperateSelected,
  }
  panelSlots[state.side].viewState = state.viewState
}

const playlistRequest = ref(null), playlistBusy = ref(false), playlistError = ref(''), playlistStatus = ref('')
let playlistController = null
const playlistDirectory = () => ({ providerId: panelSlots[activePanel.value].providerId, path: panelStates[activePanel.value].currentDirectory?.path })
const requestPlaylistCommand = (mode) => {
  const directory = playlistDirectory()
  playlistError.value = ''
  playlistRequest.value = { mode, directory,
    title: { url: 'Open media URL', import: 'Import playlist', export: 'Export playlist' }[mode],
    button: mode === 'export' ? 'Save' : 'Open',
    description: mode === 'url' ? 'Open an HTTP or HTTPS audio, video, or HLS source.' : `In: ${directory.path || 'Select a folder in the active panel'}`,
    value: mode === 'url' ? '' : mode === 'import' && isPlaylistFile(panelStates[activePanel.value].selected?.name) ? panelStates[activePanel.value].selected.name : 'playlist.m3u8' }
}
const closePlaylistCommand = () => { playlistController?.abort(); playlistRequest.value = null; playlistBusy.value = false }
const openUrlSource = createSourceOpener({ probe: mediaApi.probeSource, open: openSource, beforePlayback: playback.beforePlayback })
const openProbedSource = (location, metadata) => openUrlSource(location, { metadata })
const importAudioPlaylist = async (location, signal) => {
  const result = await importPlaylist(location, { filesystem, media: mediaApi, audio, openHls: openProbedSource, signal })
  if (!result.hls) {
    layout.audioPlaylistExpanded = true
    playlistStatus.value = `Imported ${result.imported} tracks · Skipped ${result.skipped} unsupported or unavailable entries${result.duplicates ? ` · ${result.duplicates} duplicates` : ''}`
  }
}
const saveAudioPlaylist = async (destination, overwrite = false) => {
  const text = exportM3u(audio.state.items, destination)
  const split = Math.max(destination.path.lastIndexOf('/'), destination.path.lastIndexOf('\\'))
  const directory = { providerId: destination.providerId, path: playlistParentPath(destination.path) }
  const name = destination.path.slice(split + 1)
  if (!overwrite) {
    const listing = await filesystem.readDir(directory)
    if (!listing.ok) throw new Error(listing.error?.message || 'Unable to read destination')
    if (listing.entries.some((item) => item.name === name)) {
      confirmationRequest.value = { action: 'overwrite-playlist', destination, source: { name, path: destination.path }, targetDirectory: { name: directory.path } }
      return
    }
    const created = await filesystem.createFile(directory, name)
    if (!created.ok) throw new Error(created.error?.message || 'Unable to create playlist')
  }
  const response = await filesystem.writeText(destination, text)
  if (!response.ok) throw new Error(response.error?.message || 'Unable to save playlist')
  filesystemRevision.value++
  playlistStatus.value = `Exported ${audio.state.items.length} tracks`
}
const submitPlaylistCommand = async (value) => {
  const request = playlistRequest.value
  if (!request || playlistBusy.value) return
  const controller = new AbortController(); playlistController = controller
  playlistBusy.value = true; playlistError.value = ''
  try {
    if (request.mode === 'url') {
      const location = normalizeMediaSource({ sourceType: 'url', url: value })
      await openUrlSource(location, { signal: controller.signal })
    } else {
      if (!request.directory.path) throw new Error('Select a folder in the active panel')
      const location = playlistDestination(request.directory, value)
      if (request.mode === 'import') await importAudioPlaylist(location, controller.signal)
      else await saveAudioPlaylist(location)
    }
    if (!controller.signal.aborted) playlistRequest.value = null
  } catch (error) { if (!controller.signal.aborted) playlistError.value = request.mode === 'url' ? (error.message.startsWith('Only HTTP') || error.message.startsWith('Enter a valid') ? error.message : 'Unable to open this media source') : error.message }
  finally { if (playlistController === controller) playlistBusy.value = false }
}
const openFile = (context) => {
  if (isPlaylistFile(context?.node?.name) && context.type !== 'text') {
    void importAudioPlaylist({ sourceType: 'provider', providerId: context.filesystemId || 'local', path: context.node.path })
      .catch((error) => { audio.state.visible = true; layout.audioPlaylistExpanded = true; playlistStatus.value = error.message })
    return
  }
  const type = context?.type || getFileOpenType(
    context?.node?.name,
    settings.value.editor.editableFiles,
  )

  if (isMediaOpenType(type)) {
    void openCoordinatedMedia(context)
    return
  }

  if (!isWorkspaceDocumentType(type)) {
    return
  }

  workspaceMode.value = 'editor'
  if (type === 'text') {
    void openTextDocument({ ...context, type }, {
      openText: openEditorFile, isOpen: tab => editorTabs.value.some(candidate => candidate.id === tab.id),
      closeText: closeEditorTab, openVideo: openCoordinatedMedia,
      onVideo: () => { workspaceMode.value = editorTabs.value.length ? 'editor' : 'files' },
    })
  } else {
    openEditorFile({ ...context, type })
  }
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
    return copyEntry(source, source.targetDirectory || targetDirectory, source.targetName)
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

const runFileOperations = async (action, sources, targetDirectory, requestDetails, isCurrent) => {
  // A single-item request (context-menu Delete) may carry only `source`.
  const effectiveSources = transferSources(sources?.length ? sources : [requestDetails?.source].filter(Boolean))
  const processedSources = []
  for (const source of effectiveSources) {
    if (!isCurrent()) return { ok: false, processedSources, error: { code: 'ECANCELLED' } }
    let response
    try {
      response = await runFileOperation(action, source, targetDirectory)
    } catch (error) {
      response = { ok: false, error: { message: error?.message || 'The file operation failed' } }
    }
    if (!isCurrent()) return { ok: false, processedSources, error: { code: 'ECANCELLED' } }
    if (!response?.ok) {
      // A recursive operation can fail after changing children. Refresh even
      // when no top-level source has completed. Never imply rollback.
      return {
        ok: false,
        processedSources,
        error: { ...response?.error, message: `${source.name}: ${response?.error?.message || 'The file operation failed'}${response?.error?.path ? `: ${response.error.path}` : ''} (${processedSources.length} completed)` },
      }
    }
    syncAfterFileOperation({ ...requestDetails, action, source, target: source.targetDirectory || targetDirectory }, response)
    processedSources.push(source)
  }
  return { ok: true, processedSources }
}

const finishTransferredSelection = (action, sourcePanel, sources) => {
  if (!['move', 'delete'].includes(action)) return
  // Paste and external drops have no source panel: either may show the items.
  const panels = sourcePanel ? [sourcePanel === 'left' ? leftPanel.value : rightPanel.value] : [leftPanel.value, rightPanel.value]
  panels.forEach((panel) => panel?.removeSelectedPaths(sources))
}

const openFileOperationMenu = async (requestDetails) => {
  if (requestDetails.external) {
    const response = await requestDetails.external
    if (!response.ok) { showNotice('Unable to drop these items', response.error); return }
    const items = response.items.filter((item) => !(item.providerId === requestDetails.target.providerId &&
      item.path === requestDetails.target.path))
    if (!items.length) return
    requestDetails = { ...requestDetails, external: undefined, source: { ...items[0], panelSide: null, ...(items.length > 1 ? { sources: items } : {}) } }
  }
  entryContextRequest.value = null
  activePanel.value = requestDetails.targetPanel
  operationGeneration++
  dropRequest.value = {
    ...requestDetails,
    sources: requestDetails.source.sources || [requestDetails.source],
    sourcePanel: requestDetails.source.panelSide,
  }
  operationBusy.value = false
  activeOperation.value = ''
  operationError.value = ''
}

const openEntryContextMenu = (requestDetails) => {
  activePanel.value = requestDetails.sourcePane
  entryContextBusy.value = false
  entryContextError.value = ''
  entryContextRequest.value = requestDetails
}

const closeEntryContextMenu = () => {
  if (entryContextBusy.value) return
  entryContextRequest.value = null
}

const executeDesktopAction = async (action) => {
  const request = entryContextRequest.value
  if (!request || entryContextBusy.value) return
  entryContextBusy.value = true
  entryContextError.value = ''
  try {
    const response = await desktop[action]({
      providerId: request.node.providerId,
      path: request.node.path,
    })
    if (response.ok || response.error?.code === 'ECANCELLED') {
      entryContextRequest.value = null
    } else {
      entryContextError.value = response.error?.message || 'The desktop action failed'
    }
  } catch (error) {
    entryContextError.value = error?.message || 'The desktop action failed'
  } finally {
    entryContextBusy.value = false
  }
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

const executeEntryContextRename = () => {
  const requestDetails = entryContextRequest.value

  if (!requestDetails) {
    return
  }

  entryContextRequest.value = null
  activePanel.value = requestDetails.sourcePane
  const panel = requestDetails.sourcePane === 'left' ? leftPanel.value : rightPanel.value
  panel?.requestRename(requestDetails.node)
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
    sources: [requestDetails.node],
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
  const generation = ++operationGeneration
  const response = await settleFileOperation({
    run: () => runFileOperations(action, requestDetails.sources, requestDetails.target, requestDetails, () => generation === operationGeneration),
    setBusy: (value) => { operationBusy.value = value },
    refresh: () => { filesystemRevision.value += 1 },
    isCurrent: () => generation === operationGeneration,
  })
  if (generation !== operationGeneration) return

  if (!response?.ok) {
    activeOperation.value = ''
    operationError.value = response?.error?.message || 'The file operation failed'
    if (response.processedSources?.length) {
      finishTransferredSelection(action, requestDetails.sourcePanel, response.processedSources)
      filesystemRevision.value += 1
      const remaining = transferSources(dropRequest.value.sources).filter((source) =>
        !response.processedSources.some((done) =>
          done.providerId === source.providerId && done.path === source.path))
      dropRequest.value = {
        ...dropRequest.value,
        source: { ...remaining[0], panelSide: requestDetails.sourcePanel },
        sources: remaining,
      }
    }
    return
  }

  finishTransferredSelection(action, requestDetails.sourcePanel, response.processedSources)
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
  confirmationGeneration++
  confirmationRequest.value = {
    action,
    source: sourcePanel.selected,
    sources: sourcePanel.selectedEntries,
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

  confirmationGeneration++
  confirmationRequest.value = null
  confirmationError.value = ''
}

const executeCommanderOperation = async () => {
  if (confirmationRequest.value?.action === 'overwrite-playlist') {
    confirmationBusy.value = true; confirmationError.value = ''
    try { await saveAudioPlaylist(confirmationRequest.value.destination, true); confirmationRequest.value = null }
    catch (error) { confirmationError.value = error.message }
    finally { confirmationBusy.value = false }
    return
  }
  if (!confirmationRequest.value || confirmationBusy.value || confirmationRequest.value.action === 'notice') {
    return
  }

  const requestDetails = confirmationRequest.value
  confirmationBusy.value = true
  confirmationError.value = ''
  const generation = ++confirmationGeneration
  const response = await settleFileOperation({
    run: () => runFileOperations(requestDetails.action, requestDetails.sources, requestDetails.targetDirectory, requestDetails, () => generation === confirmationGeneration),
    setBusy: (value) => { confirmationBusy.value = value },
    refresh: () => { filesystemRevision.value += 1 },
    isCurrent: () => generation === confirmationGeneration,
  })
  if (generation !== confirmationGeneration) return

  if (!response?.ok) {
    confirmationError.value =
      response?.error?.message || 'The file operation failed'
    if (response.processedSources?.length) {
      finishTransferredSelection(requestDetails.action, requestDetails.sourcePanel, response.processedSources)
      filesystemRevision.value += 1
      const remaining = transferSources(requestDetails.sources).filter((source) =>
        !response.processedSources.some((done) =>
          done.providerId === source.providerId && done.path === source.path))
      confirmationRequest.value = {
        ...requestDetails,
        source: remaining[0],
        sources: remaining,
      }
    }
    return
  }

  finishTransferredSelection(requestDetails.action, requestDetails.sourcePanel, response.processedSources)
  confirmationRequest.value = null
  filesystemRevision.value += 1
  if (requestDetails.paste?.consumes) {
    const consumed = await fileClipboard.consume(requestDetails.paste.token, 'cut')
    if (!consumed.ok) showNotice('Clipboard not updated', consumed.error)
  }
}


// --- File clipboard, native drag and drop, disk images ----------------------
const fileClipboard = useFileClipboard()
const { notice, showNotice, clearNotice } = useNotice()
const shortcutLabels = clipboardShortcutLabels()
const entryContextImage = ref(null)
let imageStatusSequence = 0

watch(notice, (value) => {
  if (!value) return
  clearNotice()
  if (confirmationRequest.value) {
    confirmationError.value = value.message
    return
  }
  confirmationError.value = ''
  confirmationRequest.value = { action: 'notice', title: value.title, message: value.message, source: { name: '' } }
})

const panelOf = (side) => (side === 'left' ? leftPanel.value : rightPanel.value)

// Items a context-menu Cut/Copy applies to: the selection when the clicked
// row is part of it, otherwise the clicked row alone.
const contextEntries = (request, includeRoot = false) => {
  if (!request || request.background || (!includeRoot && isFilesystemRootEntry(request.node))) return []
  const selection = panelStates[request.sourcePane]?.selectedEntries || []
  return selection.some((entry) => entry.path === request.node.path) ? selection : [request.node]
}

const contextPasteTarget = (request) => {
  if (!request) return null
  if (request.background || request.node.isDirectory) return { ...request.node, providerId: request.node.providerId, isDirectory: true }
  return panelStates[request.sourcePane]?.currentDirectory || null
}

const entryContextClipboard = computed(() => {
  const request = entryContextRequest.value
  if (!request) return null
  const entries = contextEntries(request)
  const destination = contextPasteTarget(request)
  return {
    canCut: entries.length > 0,
    canCopy: entries.length > 0,
    canPaste: Boolean(fileClipboard.state.snapshot && !pasteBlockReason(fileClipboard.state.snapshot, destination)),
    pasteLabel: !request.background && request.node.isDirectory ? 'Paste into Folder' : 'Paste',
    shortcuts: shortcutLabels,
  }
})

const writeClipboard = async (operation, entries) => {
  if (!entries.length) return false
  const response = await fileClipboard[operation](entries)
  if (!response.ok) showNotice(operation === 'cut' ? 'Unable to cut' : 'Unable to copy', response.error)
  return response.ok
}

const pasteInto = async (destination, targetPanel) => {
  if (!destination || confirmationRequest.value || confirmationBusy.value) return
  const read = await fileClipboard.refresh()
  if (!read.ok) { showNotice('Unable to paste', read.error); return }
  const snapshot = fileClipboard.state.snapshot
  let names = []
  if (snapshot?.operation === 'copy' && snapshot.items.some((item) => item.providerId === destination.providerId &&
    getFilesystemParentPath(item.path) === destination.path)) {
    const listing = await filesystem.readDir(destination)
    if (!listing.ok) { showNotice('Unable to paste', listing.error); return }
    names = listing.entries.map((entry) => entry.name)
  }
  const plan = planPaste(snapshot, destination, names)
  if (!plan.ok) { showNotice('Unable to paste', plan.error); return }
  if (!plan.sources.length) return
  activePanel.value = targetPanel || activePanel.value
  confirmationError.value = ''
  confirmationGeneration++
  confirmationRequest.value = {
    action: plan.action,
    paste: plan,
    source: plan.sources[0],
    sources: plan.sources,
    sourcePanel: null,
    targetDirectory: destination,
    targetPanel,
  }
  await executeCommanderOperation()
}

// Finder-style Duplicate: copy each item next to itself with a free name
// ("name copy.ext"), through the same copy operation and progress dialog.
const duplicateEntries = async (entries, targetPanel) => {
  if (!entries.length || confirmationRequest.value || confirmationBusy.value) return
  const groups = new Map()
  for (const entry of transferSources(entries)) {
    const parent = getFilesystemParentPath(entry.path)
    if (!groups.has(parent)) groups.set(parent, [])
    groups.get(parent).push(entry)
  }
  const sources = []
  for (const [parent, items] of groups) {
    const directory = { providerId: items[0].providerId, path: parent, name: parent, isDirectory: true }
    const listing = await filesystem.readDir(directory)
    if (!listing.ok) { showNotice('Unable to duplicate', listing.error); return }
    const plan = planPaste({ operation: 'copy', items }, directory, listing.entries.map((entry) => entry.name))
    if (!plan.ok) { showNotice('Unable to duplicate', plan.error); return }
    sources.push(...plan.sources.map((source) => ({ ...source, targetDirectory: directory })))
  }
  confirmationError.value = ''
  confirmationGeneration++
  confirmationRequest.value = {
    action: 'copy',
    paste: { action: 'copy', duplicate: true, consumes: false, token: null },
    source: sources[0],
    sources,
    sourcePanel: null,
    targetDirectory: sources[0].targetDirectory,
    targetPanel,
  }
  await executeCommanderOperation()
}

const executeEntryClipboard = async (operation) => {
  const request = entryContextRequest.value
  if (!request || entryContextBusy.value) return
  if (operation === 'paste') {
    entryContextRequest.value = null
    await pasteInto(contextPasteTarget(request), request.sourcePane)
    return
  }
  if (operation === 'duplicate') {
    entryContextRequest.value = null
    await duplicateEntries(contextEntries(request), request.sourcePane)
    return
  }
  if (await writeClipboard(operation, contextEntries(request))) entryContextRequest.value = null
}

const clipboardShortcutsBlocked = () => Boolean(
  workspaceMode.value !== 'files' || !connected.value || settingsOpen.value || remoteConnectionsOpen.value ||
  createRequest.value || confirmationRequest.value || archiveRequest.value || playlistRequest.value || viewer.value ||
  quickLook.current.value || propertiesState.current.value || dropRequest.value || entryContextRequest.value || operationBusy.value ||
  confirmationBusy.value || panelOf(activePanel.value)?.hasOpenMenu(),
)

const handleClipboardShortcut = (event) => {
  const operation = fileClipboardShortcut(event)
  if (!operation || clipboardShortcutsBlocked()) return false
  const state = panelStates[activePanel.value]
  if (operation === 'paste') {
    if (!state?.currentDirectory) return false
    event.preventDefault()
    void pasteInto(state.currentDirectory, activePanel.value)
    return true
  }
  if (!state?.canOperateSelected || !state.selectedEntries.length) return false
  event.preventDefault()
  void writeClipboard(operation, state.selectedEntries)
  return true
}

const refreshEntryContextImage = (request) => {
  const sequence = ++imageStatusSequence
  entryContextImage.value = canOfferDiskImage(request?.node, runtime.capabilities) ? { mounted: null } : null
  if (!entryContextImage.value) return
  void diskImages.status(request.node).then((response) => {
    if (sequence !== imageStatusSequence || entryContextRequest.value !== request) return
    // A status failure still offers Mount; the backend validates again.
    entryContextImage.value = { mounted: response.ok ? response.image.attached : false }
  })
}

const executeDiskImage = async (action) => {
  const request = entryContextRequest.value
  if (!request || entryContextBusy.value) return
  entryContextBusy.value = true
  entryContextError.value = ''
  try {
    const response = await diskImages[action]({ providerId: request.node.providerId, path: request.node.path })
    if (!response.ok) { entryContextError.value = response.error.message; return }
    entryContextRequest.value = null
    filesystemRevision.value += 1
    const volume = action === 'mount' ? response.image.volumes?.[0] : null
    if (volume?.mountPoint) {
      panelOf(request.sourcePane)?.openDirectory({ name: volume.name || volume.mountPoint, path: volume.mountPoint, type: 'directory', isDirectory: true })
    }
  } catch (error) {
    entryContextError.value = error?.message || 'The disk image operation failed'
  } finally {
    entryContextBusy.value = false
  }
}

const handleNativeDrop = ({ x, y } = {}) => {
  const source = activeNativeDrag()
  if (!source) return
  const target = nativeDropTarget(x, y)
  if (target?.kind === 'terminal') {
    target.element.dispatchEvent(new CustomEvent('vesperwind:terminal-drop', { detail: { value: source.terminalPath } }))
    return
  }
  if (target?.kind !== 'directory' || isComputerPath(target.target.path)) return
  if (source.providerId === target.target.providerId && (source.sources || [source]).some((item) => item.path === target.target.path)) return
  void openFileOperationMenu({ source, target: target.target, targetPanel: target.targetPanel, x, y })
}

watch(entryContextRequest, (request) => {
  if (!request) return
  void fileClipboard.refresh()
  refreshEntryContextImage(request)
})

const shellSubscriptions = []

const openProperties = (context) => {
  if (!context?.node || isComputerPath(context.node.path)) return
  entryContextRequest.value = null
  void propertiesState.open(context, settings.value.editor.editableFiles)
}
const handleCommanderKeydown = (event) => {
  if (propertiesState.current.value) return
  const panel = activePanel.value === 'left' ? leftPanel.value : rightPanel.value
  if (canOpenProperties(event, { selectedCount: panelStates[activePanel.value].selectedEntries.length,
    workspaceMode: workspaceMode.value, panelVisible: Boolean(panel), blocked: clipboardShortcutsBlocked() })) {
    event.preventDefault()
    openProperties(panel.quickLookContext())
    return
  }
  if (canOpenQuickLook(event, { workspaceMode: workspaceMode.value, selected: panelStates[activePanel.value].selected,
    panelVisible: Boolean(panel), blocked: !connected.value || settingsOpen.value || remoteConnectionsOpen.value || createRequest.value || confirmationRequest.value || archiveRequest.value || viewer.value || quickLook.current.value || propertiesState.current.value || dropRequest.value || entryContextRequest.value || operationBusy.value || confirmationBusy.value || panel?.hasOpenMenu() })) {
    event.preventDefault()
    void quickLook.open(panel.quickLookContext(), settings.value.editor.editableFiles)
    return
  }
  if (isAddressShortcut(event) && !event.target.closest?.('.xterm') && workspaceMode.value === 'files' && !settingsOpen.value && !remoteConnectionsOpen.value && !createRequest.value && !confirmationRequest.value && !archiveRequest.value && !viewer.value && !quickLook.current.value && !propertiesState.current.value && !dropRequest.value && !entryContextRequest.value) {
    const panel = activePanel.value === 'left' ? leftPanel.value : rightPanel.value
    if (panel) { event.preventDefault(); void panel.editAddress() }
    return
  }
  if (handleClipboardShortcut(event)) return
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
  loadSettings().then((response) => {
    // The app keeps working with defaults; the newer file stays unchanged.
    if (response?.error?.code === 'ESETTINGS_NEWER_VERSION') showNotice('Update Vesperwind', response.error)
  })
  unsubscribeNativeSettings = onNativeOpenSettings(openSettings)
  shellSubscriptions.push(installNativeEditHistory())
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
  shellSubscriptions.push(
    fileClipboard.subscribe(showNotice),
    onShellEvent('native-drag:drop', handleNativeDrop),
    onShellEvent('native-drag:end', () => endNativeDrag()),
    onShellEvent('native-drag:error', (event) => showNotice('Transfer failed', event?.error)),
  )
  void fileClipboard.refresh()
})

onBeforeUnmount(() => {
  propertiesState.close()
  operationGeneration++
  confirmationGeneration++
  operationBusy.value = false
  confirmationBusy.value = false
  confirmationRequest.value = null
  dropRequest.value = null
  quickLook.close()
  archiveJob?.dispose()
  clearPanelDrag()
  unsubscribeNativeSettings?.()
  unsubscribeConnection?.()
  workspaceObserver?.disconnect()
  window.removeEventListener('resize', clampTerminalToViewport)
  window.removeEventListener('keydown', handleCommanderKeydown)
  shellSubscriptions.splice(0).forEach((stop) => stop?.())
})
</script>

<template>
  <main class="app-shell">
    <Toolbar
      :layout="layout"
      :audio-visible="audioVisible"
      :active-panel="activePanel"
      :connected="connected"
      :command-availability="commandAvailability"
      :workspace-mode="workspaceMode"
      :editor-available="editorAvailable"
      @toggle-left="toggleLeftPanel"
      @toggle-right="toggleRightPanel"
      @toggle-terminal="toggleTerminal"
      @toggle-audio="audio.toggleVisible()"
      @open-settings="openSettings"
      @copy="openCommanderConfirmation('copy')"
      @move="openCommanderConfirmation('move')"
      @delete="openCommanderConfirmation('delete')"
      @create="openCreate"
      @archive-create="openArchive('create')"
      @archive-extract="openArchive('extract')"
      @show-files="showFiles"
      @show-editor="showEditor"
      @open-remote="remoteConnectionsOpen = true"
    />

    <AudioPlayerBar ref="audioPlayerBar" v-show="audioVisible" :audio="audio" :expanded="layout.audioPlaylistExpanded"
      @toggle-playlist="layout.audioPlaylistExpanded = !layout.audioPlaylistExpanded" />

    <div ref="workspace" class="workspace">
      <AudioPlaylist v-if="playlistVisible" :audio="audio" :status="playlistStatus" @open-url="requestPlaylistCommand('url')" @import="requestPlaylistCommand('import')" @export="requestPlaylistCommand('export')" :style="playlistStyle" />
      <Splitter v-if="playlistVisible" orientation="horizontal" @resize="resizePlaylist" />
      <div v-show="workspaceMode === 'files'" ref="filesContainer" class="files-container">
        <FilePanel
          :key="`${panelSlots.left.id}:${panelSlots.left.providerId}`"
          ref="leftPanel"
          v-if="layout.leftVisible"
          side="left"
          :panel-id="panelSlots.left.id"
          :initial-view-state="panelSlots.left.viewState"
          :provider-id="panelSlots.left.providerId"
          :provider-label="panelSlots.left.label"
          :active="activePanel === 'left'"
          :swap-source="panelDrag?.started && panelDrag.side === 'left'"
          :swap-target="panelSwapTarget === 'left'"
          :filesystem-revision="filesystemRevision"
          :watch-active="workspaceMode === 'files'"
          :style="leftPanelStyle"
          @activate="activate('left')"
          @collapse="hideLeft"
          @drop-request="openFileOperationMenu"
          @context-menu="openEntryContextMenu"
          @open-file="openFile"
          @panel-drag-candidate="beginPanelDrag"
          @state-change="updatePanelState"
        />

        <Splitter
          v-if="bothPanelsVisible"
          orientation="vertical"
          seam
          @resize="resizePanels"
        />

        <FilePanel
          :key="`${panelSlots.right.id}:${panelSlots.right.providerId}`"
          ref="rightPanel"
          v-if="layout.rightVisible"
          side="right"
          :panel-id="panelSlots.right.id"
          :initial-view-state="panelSlots.right.viewState"
          :provider-id="panelSlots.right.providerId"
          :provider-label="panelSlots.right.label"
          :active="activePanel === 'right'"
          :swap-source="panelDrag?.started && panelDrag.side === 'right'"
          :swap-target="panelSwapTarget === 'right'"
          :filesystem-revision="filesystemRevision"
          :watch-active="workspaceMode === 'files'"
          :style="rightPanelStyle"
          @activate="activate('right')"
          @collapse="hideRight"
          @drop-request="openFileOperationMenu"
          @context-menu="openEntryContextMenu"
          @open-file="openFile"
          @panel-drag-candidate="beginPanelDrag"
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
        @manage-connections="remoteConnectionsOpen = true"
      />
    </div>

    <PlaylistCommandModal :request="playlistRequest" :busy="playlistBusy" :error="playlistError" @submit="submitPlaylistCommand" @close="closePlaylistCommand" />
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
    <RemoteConnectionsModal :open="remoteConnectionsOpen" :active-panel="activePanel" @close="remoteConnectionsOpen = false" @connected="handleRemoteConnected" />
    <CreateEntryModal :request="createRequest" :busy="createBusy" :error="createError" @confirm="submitCreate" @cancel="!createBusy && (createRequest = null)" />
    <MediaViewerModal
      :open="Boolean(viewer)"
      :media="currentViewerMedia"
      :kind="viewer?.kind || ''"
      :position="viewerPosition"
      :total="viewerCount"
      @close="handleViewerClose"
      @previous="showPrevious"
      @next="showNext"
      @retry="retryMedia"
    />
    <PropertiesModal v-if="propertiesState.current.value" :state="propertiesState" @close="propertiesState.close()" />
    <QuickLookModal v-if="quickLookPreview" :key="quickLookPreview.id" :preview="quickLookPreview" @close="quickLook.close" />
    <ArchiveOperationModal :open="Boolean(archiveRequest)" :request="archiveRequest" :busy="archiveBusy" :cancelling="archiveCancelling" :progress="archiveProgress" :error="archiveError" @submit="submitArchive" @cancel="cancelArchive" />
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
      :properties-available="!isComputerPath(entryContextRequest.node.path) && contextEntries(entryContextRequest, true).length === 1"
      :native-actions="desktop.available && entryContextRequest.node.providerId === 'local'"
      :open-with-available="desktop.canOpenWith"
      :reveal-label="desktop.revealLabel"
      :archive-actions="entryContextRequest.node.providerId === 'local' && !archiveBusy"
      :busy="entryContextBusy"
      :error="entryContextError"
      :clipboard="entryContextClipboard"
      :background="Boolean(entryContextRequest.background)"
      :disk-image="entryContextRequest.background ? null : entryContextImage"
      @cut="executeEntryClipboard('cut')"
      @copy="executeEntryClipboard('copy')"
      @paste="executeEntryClipboard('paste')"
      @duplicate="executeEntryClipboard('duplicate')"
      @mount-image="executeDiskImage('mount')"
      @unmount-image="executeDiskImage('unmount')"
      @properties="openProperties({ node: entryContextRequest.node, filesystemId: entryContextRequest.node.providerId })"
      @open="executeEntryContextOpen"
      @system-open="executeDesktopAction('open')"
      @open-with="executeDesktopAction('openWith')"
      @reveal="executeDesktopAction('reveal')"
      @rename="executeEntryContextRename"
      @delete="executeEntryContextDelete"
      @archive-create="openArchive('create', true)"
      @archive-extract="openArchive('extract', true)"
      @cancel="closeEntryContextMenu"
    />
  </main>
</template>
