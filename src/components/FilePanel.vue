<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFilesystem } from '../composables/useFilesystem.js'
import { useSettings } from '../composables/useSettings.js'
import { buildPathBreadcrumbs } from '../utils/pathBreadcrumbs.js'
import { getFilesystemPathName } from '../utils/filesystemPath.js'
import { isSameOrDescendantPath } from '../utils/filesystemPath.js'
import { selectFileEntries } from '../utils/fileSelection.js'
import FileTree from './FileTree.vue'
import { entryChange, relocatePath } from '../composables/useEntryChanges.js'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'
import { FILE_ENTRY_MIME, parseFileDragPayload } from '../utils/fileDrag.js'
import { isPanelSwapHandle, restorePanelViewState } from '../utils/panelSwap.js'

const props = defineProps({
  panelId: { type: String, required: true },
  initialViewState: { type: Object, default: null },
  side: {
    type: String,
    required: true,
    validator: (value) => ['left', 'right'].includes(value),
  },
  active: {
    type: Boolean,
    default: false,
  },
  providerId: {
    type: String,
    default: LOCAL_FILESYSTEM_PROVIDER,
  },
  providerLabel: {
    type: String,
    default: 'Local',
  },
  filesystemRevision: {
    type: Number,
    default: 0,
  },
  swapSource: {
    type: Boolean,
    default: false,
  },
  swapTarget: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'activate',
  'collapse',
  'drop-request',
  'open-file',
  'context-menu',
  'panel-drag-candidate',
  'state-change',
])
const { getRoot, listDirectory } = useFilesystem(props.providerId)
const { revision: settingsRevision } = useSettings()
const filesystemRoot = ref(null)
const homePath = ref('')
const root = ref(null)
const selectedNode = ref(null)
const selectedPath = ref('')
const selectedEntries = ref([])
const selectionAnchorPath = ref('')
const expandedPaths = ref([])
const scrollTop = ref(0)
const panelContentRef = ref(null)
let restoringScroll = false
const renameRequest = ref(null)
let renameRequestSequence = 0
const loading = ref(true)
const error = ref(null)
const breadcrumbsRef = ref(null)
const rootDropTarget = ref(false)
const breadcrumbs = computed(() =>
  buildPathBreadcrumbs(filesystemRoot.value, root.value?.path),
)
const selectedPaths = computed(() => selectedEntries.value.map((entry) => entry.path))
const panelState = computed(() => ({
  side: props.side,
  panelId: props.panelId,
  currentDirectory: root.value
    ? { ...root.value, providerId: props.providerId }
    : null,
  selected: selectedNode.value
    ? { ...selectedNode.value, providerId: props.providerId }
    : null,
  selectedEntries: selectedEntries.value.map((entry) => ({ ...entry, providerId: props.providerId })),
  canOperateSelected: Boolean(
    selectedEntries.value.length > 0,
  ),
  viewState: {
    providerId: props.providerId,
    root: root.value,
    selectedNode: selectedNode.value,
    selectedEntries: selectedEntries.value,
    anchorPath: selectionAnchorPath.value,
    expandedPaths: expandedPaths.value,
    scrollTop: scrollTop.value,
  },
}))

const restoreScroll = async () => {
  if (!restoringScroll) return
  await nextTick()
  if (panelContentRef.value) panelContentRef.value.scrollTop = scrollTop.value
}

const handlePanelScroll = (event) => {
  if (!restoringScroll) scrollTop.value = event.target.scrollTop
}

const stopScrollRestore = () => {
  restoringScroll = false
  if (panelContentRef.value) scrollTop.value = panelContentRef.value.scrollTop
}

const loadRoot = async () => {
  loading.value = true
  error.value = null
  const response = await getRoot()
  loading.value = false

  if (!response?.ok) {
    error.value = response?.error || { message: 'Unable to load filesystem root' }
    return
  }

  filesystemRoot.value = response.root
  homePath.value = response.homePath || ''
  const initial = response.initial || response.root
  const view = restorePanelViewState(props.initialViewState, props.providerId, response.root, initial)
  root.value = view.root
  selectedNode.value = view.selectedNode
  selectedPath.value = selectedNode.value.path
  selectedEntries.value = view.selectedEntries
  selectionAnchorPath.value = view.anchorPath
  expandedPaths.value = view.expandedPaths
  scrollTop.value = view.scrollTop
  restoringScroll = view.restored
  await restoreScroll()
}

const visibleEntries = () => Array.from(
  panelContentRef.value?.querySelectorAll('.tree-row[data-file-path]') || [],
).filter((row) => row.getClientRects().length > 0).map((row) => ({
  providerId: props.providerId,
  path: row.dataset.filePath,
  name: row.dataset.fileName,
  isDirectory: row.dataset.fileDirectory === 'true',
}))

const selectNode = (payload) => {
  const node = payload?.node || payload
  if (!node) return
  if (node.path === filesystemRoot.value?.path) {
    selectedEntries.value = []
    selectionAnchorPath.value = ''
    selectedNode.value = node
    selectedPath.value = node.path
    return
  }
  const clicked = { ...node, providerId: props.providerId }
  const next = selectFileEntries({
    entries: selectedEntries.value,
    anchorPath: selectionAnchorPath.value,
    clicked,
    visibleEntries: visibleEntries(),
    shiftKey: Boolean(payload?.shiftKey),
    additiveKey: Boolean(payload?.metaKey || payload?.ctrlKey),
  })
  selectedEntries.value = next.entries
  selectionAnchorPath.value = next.anchorPath
  selectedNode.value = next.active || root.value
  selectedPath.value = selectedNode.value?.path || ''
}

const updateExpanded = ({ path, expanded }) => {
  expandedPaths.value = expanded
    ? [...new Set([...expandedPaths.value, path])]
    : expandedPaths.value.filter((value) => value !== path)
}

const removeSelectedPaths = (sources) => {
  const removed = sources.filter((source) => source.providerId === props.providerId)
  selectedEntries.value = selectedEntries.value.filter((entry) =>
    !removed.some((source) => isSameOrDescendantPath(source.path, entry.path)))
  selectedNode.value = selectedEntries.value.at(-1) || root.value
  selectedPath.value = selectedNode.value?.path || ''
  if (!selectedEntries.value.some((entry) => entry.path === selectionAnchorPath.value)) {
    selectionAnchorPath.value = selectedEntries.value[0]?.path || ''
  }
}

const requestRename = (node) => {
  if (!node) {
    return
  }

  selectNode(node)
  renameRequest.value = {
    path: node.path,
    sequence: ++renameRequestSequence,
  }
}

const openDirectory = (node) => {
  if (!node?.isDirectory) {
    return
  }

  root.value = node
  selectedNode.value = node
  selectedPath.value = node.path
  selectedEntries.value = []
  selectionAnchorPath.value = ''
}

const openNode = (payload) => {
  const node = payload?.node || payload

  if (node?.isDirectory) {
    openDirectory(node)
  } else if (node) {
    emit('open-file', {
      node,
      siblings: Array.isArray(payload?.siblings) ? payload.siblings : [node],
      filesystemId: props.providerId,
      sourcePane: props.side,
      sourceRootPath: root.value?.path,
      sourceRootName: root.value?.name,
      filesystemRoot: filesystemRoot.value,
      homePath: homePath.value,
    })
  }
}

const entryContext = (payload) => ({
  node: { ...payload.node, providerId: props.providerId },
  siblings: Array.isArray(payload.siblings) ? payload.siblings : [payload.node],
  filesystemId: props.providerId,
  sourcePane: props.side,
  sourceRootPath: root.value?.path,
  sourceRootName: root.value?.name,
  filesystemRoot: filesystemRoot.value,
  homePath: homePath.value,
})

const openEntryContextMenu = (payload) => {
  if (!selectedEntries.value.some((entry) => entry.path === payload.node.path)) {
    selectNode(payload.node)
  }
  emit('context-menu', {
    ...entryContext(payload),
    x: payload.x,
    y: payload.y,
  })
}

const carriesFileEntry = (event) =>
  Array.from(event.dataTransfer?.types || []).includes(FILE_ENTRY_MIME)

const isDirectoryDropTarget = (event) =>
  Boolean(event.target?.closest?.('[data-directory-drop-target]'))

const clearRootDropTarget = () => {
  rootDropTarget.value = false
}

const handlePanelDragOver = (event) => {
  if (!root.value?.isDirectory || !carriesFileEntry(event)) {
    clearRootDropTarget()
    return
  }

  if (isDirectoryDropTarget(event)) {
    clearRootDropTarget()
    return
  }

  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  rootDropTarget.value = true
}

const handlePanelDragLeave = (event) => {
  if (event.currentTarget.contains(event.relatedTarget)) {
    return
  }

  clearRootDropTarget()
}

const handlePanelDrop = (event) => {
  clearRootDropTarget()

  if (!root.value?.isDirectory || isDirectoryDropTarget(event) || !carriesFileEntry(event)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  const source = parseFileDragPayload(event.dataTransfer.getData(FILE_ENTRY_MIME))

  if (!source || (source.providerId === props.providerId && source.path === root.value.path)) {
    return
  }

  emit('drop-request', {
    source,
    target: {
      providerId: props.providerId,
      path: root.value.path,
      name: root.value.name,
      isDirectory: true,
    },
    targetPanel: props.side,
    x: event.clientX,
    y: event.clientY,
  })
}

const navigateToBreadcrumb = (crumb) => {
  if (crumb.path === root.value?.path) {
    return
  }

  openDirectory({
    name: crumb.name,
    path: crumb.path,
    type: 'directory',
    isDirectory: true,
    isSymbolicLink: false,
  })
}

const handleHeaderPointerDown = (event) => {
  if (event.button !== 0 || !isPanelSwapHandle(event.target)) {
    return
  }

  emit('panel-drag-candidate', {
    side: props.side,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
  })
}

watch(
  () => root.value?.path,
  async () => {
    await nextTick()

    if (breadcrumbsRef.value) {
      breadcrumbsRef.value.scrollLeft = breadcrumbsRef.value.scrollWidth
    }
  },
)

watch(
  panelState,
  (state) => emit('state-change', state),
  { immediate: true, flush: 'sync' },
)

onMounted(() => {
  loadRoot()
  window.addEventListener('dragend', clearRootDropTarget)
  window.addEventListener('drop', clearRootDropTarget)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragend', clearRootDropTarget)
  window.removeEventListener('drop', clearRootDropTarget)
})

defineExpose({ openNode, requestRename, removeSelectedPaths })

watch(entryChange, (change) => {
  if (change?.action !== 'rename' || change.providerId !== props.providerId) return
  const relocateNode = (node) => {
    if (!node) return node
    const path = relocatePath(node.path, change)
    return path === node.path ? node : { ...node, path, name: getFilesystemPathName(path) }
  }
  root.value = relocateNode(root.value)
  selectedNode.value = relocateNode(selectedNode.value)
  selectedPath.value = relocatePath(selectedPath.value, change)
  selectedEntries.value = selectedEntries.value.map(relocateNode)
  selectionAnchorPath.value = relocatePath(selectionAnchorPath.value, change)
  expandedPaths.value = expandedPaths.value.map((path) => relocatePath(path, change))
})
</script>

<template>
  <section
    class="file-panel"
    :class="{
      'is-active': active,
      'is-root-drop-target': rootDropTarget,
      'is-panel-swap-source': swapSource,
      'is-panel-swap-target': swapTarget,
    }"
    :aria-label="`${side} file panel`"
    @pointerdown="$emit('activate')"
    @dragover.capture="handlePanelDragOver"
    @dragleave="handlePanelDragLeave"
    @drop="handlePanelDrop"
  >
    <header
      class="panel-header"
      :data-panel-swap-target="side"
      @pointerdown="handleHeaderPointerDown"
    >
      <div class="panel-title">
        <i class="mdi mdi-folder-multiple-outline" aria-hidden="true" />
        <strong>{{ side === 'left' ? 'Left' : 'Right' }}</strong>
        <span class="badge text-bg-secondary panel-provider-label">{{ providerLabel }}</span>
        <nav
          v-if="breadcrumbs.length"
          ref="breadcrumbsRef"
          class="panel-breadcrumbs"
          :aria-label="`${side} panel path`"
        >
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <i
              v-if="index > 0"
              class="mdi mdi-chevron-right breadcrumb-separator"
              aria-hidden="true"
            />
            <button
              class="path-segment"
              :class="{ 'is-current': index === breadcrumbs.length - 1 }"
              :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined"
              type="button"
              :title="crumb.path"
              @click.stop="navigateToBreadcrumb(crumb)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </nav>
        <span v-else class="panel-path">Loading…</span>
      </div>
      <button
        class="panel-action"
        type="button"
        :aria-label="`Hide ${side} panel`"
        :title="`Hide ${side} panel`"
        @click.stop="$emit('collapse')"
      >
        <i
          class="mdi"
          :class="side === 'left' ? 'mdi-chevron-left' : 'mdi-chevron-right'"
          aria-hidden="true"
        />
      </button>
    </header>

    <div ref="panelContentRef" class="panel-content" @scroll="handlePanelScroll" @wheel.capture="stopScrollRestore" @touchstart.capture="stopScrollRestore">
      <div v-if="loading" class="panel-message">
        <i class="mdi mdi-loading mdi-spin" aria-hidden="true" />
        Reading root folder…
      </div>
      <div v-else-if="error" class="panel-message panel-message-error" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        <span>{{ error.message }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="loadRoot">
          Retry
        </button>
      </div>
      <div v-else-if="root" class="tree-table">
        <div class="tree-columns-header" aria-hidden="true">
          <span class="tree-column-name">Name</span>
          <span class="tree-column-size">Size</span>
          <span class="tree-column-date">Date</span>
        </div>
        <FileTree
          :key="`${root.path}:${settingsRevision}:${filesystemRevision}`"
          :root="root"
          :home-path="homePath"
          :provider-id="providerId"
          :panel-side="side"
          :selected-path="selectedPath"
          :selected-paths="selectedPaths"
          :selected-entries="selectedEntries"
          :expanded-paths="expandedPaths"
          :rename-request="renameRequest"
          :list-directory="listDirectory"
          @select="selectNode"
          @open="openNode"
          @drop-request="$emit('drop-request', $event)"
          @context-menu="openEntryContextMenu"
          @expanded-change="updateExpanded"
          @children-loaded="restoreScroll"
        />
      </div>
    </div>
  </section>
</template>
