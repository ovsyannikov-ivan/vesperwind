<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from 'vue'
import { isComputerPath, isFilesystemRootEntry } from '../../shared/localFilesystem.js'
import { entryNameError } from '../../shared/entryName.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { entryChange } from '../composables/useEntryChanges.js'
import { getFileIcon } from '../utils/fileIcons.js'
import { getContentAvailabilityBadge } from '../utils/contentAvailability.js'
import { useSettings } from '../composables/useSettings.js'
import {
  formatFileSize,
  formatModifiedAt,
  formatModifiedAtTitle,
} from '../utils/fileMetadata.js'
import {
  createFileDragPayload,
  FILE_ENTRY_MIME,
  parseFileDragPayload,
} from '../utils/fileDrag.js'
import {
  formatTerminalPath,
  TERMINAL_PATH_MIME,
} from '../utils/terminalPath.js'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'
import { createDirectoryListing } from '../utils/directoryListing.js'
import { traceMedia } from '../api/mediaDiagnostics.js'
import { directoryWatch } from '../api/directoryWatch.js'
import { runtime } from '../api/runtime.js'
import { externalFiles } from '../api/shellIntegration.js'
import { useFileClipboard } from '../composables/useFileClipboard.js'
import { showNotice } from '../composables/useNotice.js'
import { isCutEntry } from '../utils/fileClipboard.js'
import { fileDropKind } from '../utils/fileDrop.js'
import { beginNativeDrag, endNativeDrag, nativeDrag } from '../utils/nativeDragSession.js'

const props = defineProps({
  node: {
    type: Object,
    required: true,
  },
  depth: {
    type: Number,
    default: 0,
  },
  selectedPath: {
    type: String,
    default: '',
  },
  selectedPaths: {
    type: Array,
    default: () => [],
  },
  selectedEntries: {
    type: Array,
    default: () => [],
  },
  expandedPaths: {
    type: Array,
    default: () => [],
  },
  renameRequest: {
    type: Object,
    default: null,
  },
  homePath: {
    type: String,
    default: '',
  },
  panelSide: {
    type: String,
    required: true,
    validator: (value) => ['left', 'right'].includes(value),
  },
  providerId: {
    type: String,
    default: LOCAL_FILESYSTEM_PROVIDER,
  },
  defaultExpanded: {
    type: Boolean,
    default: false,
  },
  listDirectory: {
    type: Function,
    required: true,
  },
  compact: {
    type: Boolean,
    default: false,
  },
  scrollSelectedIntoView: {
    type: Boolean,
    default: false,
  },
  watchActive: { type: Boolean, default: true },
  refreshRevision: { type: Number, default: 0 },
  transformChildren: { type: Function, default: null },
})

const emit = defineEmits(['select', 'open', 'drop-request', 'context-menu', 'expanded-change', 'children-loaded'])
const { settings } = useSettings()
const expanded = ref(false)
const listingState = reactive({ loaded: false, loading: false, children: [], error: null, sourceEntryCount: 0 })
const { loaded, loading, children, error } = toRefs(listingState)
const dragging = ref(false)
const dropTarget = ref(false)
const { state: clipboardState } = useFileClipboard()
const cut = computed(() => props.depth > 0 &&
  isCutEntry(clipboardState.snapshot, { providerId: props.providerId, path: props.node.path }))
const rowElement = ref(null)
const { renameEntry } = useFileOperations(props.providerId)
const renaming = ref(false)
const renameName = ref('')
const renameError = ref('')
const renameBusy = ref(false)
const renameInput = ref(null)
let renameTimer = null
let lastNameClick = 0
let stopDirectoryWatch = null
const listing = createDirectoryListing({ state: listingState,
  consumer: props.panelSide,
  getLocation: () => ({ providerId: props.providerId, path: props.node.path }),
  isActive: () => expanded.value && props.node.isDirectory,
  list: (path, options) => props.listDirectory(path, options),
  onLoaded: (payload) => emit('children-loaded', payload),
})
const refreshChildren = async (event) => {
  if (!expanded.value) return
  traceMedia('directory.refresh', { panel: props.panelSide, providerId: props.providerId, path: props.node.path,
    eventPath: event?.directoryPath })
  await listing.load({ force: true })
}
const startDirectoryWatch = () => {
  if (stopDirectoryWatch || !expanded.value || !props.watchActive) return
  stopDirectoryWatch = directoryWatch.subscribe(props.providerId, props.node.path, refreshChildren)
}
const releaseDirectoryWatch = () => {
  stopDirectoryWatch?.()
  stopDirectoryWatch = null
}
const cancelRenameTimer = () => { clearTimeout(renameTimer); renameTimer = null }
const cancelRename = () => {
  if (renameBusy.value) return
  cancelRenameTimer()
  renaming.value = false
  renameError.value = ''
}
const beginRename = async () => {
  if (!selected.value || props.depth === 0 || isFilesystemRootEntry(props.node) || renameBusy.value) return
  renaming.value = true
  renameName.value = props.node.name
  renameError.value = ''
  await nextTick()
  renameInput.value?.focus()
  const dot = props.node.isDirectory ? -1 : props.node.name.lastIndexOf('.')
  renameInput.value?.setSelectionRange(0, dot > 0 ? dot : props.node.name.length)
}
const handleNameClick = (event) => {
  if (event.shiftKey || event.metaKey || event.ctrlKey || props.selectedEntries.length > 1) {
    cancelRenameTimer()
    return
  }
  const now = Date.now()
  const elapsed = now - lastNameClick
  cancelRenameTimer()
  if (event.detail === 1 && selected.value && elapsed > 500 && elapsed < 3000) {
    renameTimer = setTimeout(beginRename, 550)
  }
  lastNameClick = now
}
const submitRename = async () => {
  if (renameBusy.value) return
  renameError.value = entryNameError(renameName.value)
  if (renameError.value) return
  if (renameName.value === props.node.name) { cancelRename(); return }
  renameBusy.value = true
  try {
    const response = await renameEntry(props.node.path, renameName.value)
    if (response.ok) renaming.value = false
    else renameError.value = response.error.message
  } catch (error) {
    renameError.value = error.message || 'Unable to rename this item'
  } finally { renameBusy.value = false }
}

const selected = computed(() => props.selectedPaths.includes(props.node.path) ||
  (props.depth === 0 && props.selectedPath === props.node.path))
const activeSelection = computed(() => props.selectedPath === props.node.path)
const iconDetails = computed(() => getFileIcon(props.node, expanded.value))
const availabilityBadge = computed(() => getContentAvailabilityBadge(props.node, props.providerId))
const rowPadding = computed(() => ({ paddingLeft: `calc(var(--file-tree-row-padding) + ${props.depth} * var(--file-tree-indent))`}))
const formattedSize = computed(() =>
  formatFileSize(props.node.size, props.node.isDirectory),
)
const formattedModifiedAt = computed(() =>
  formatModifiedAt(props.node.modifiedAt, settings.value.appearance.locale),
)
const modifiedAtTitle = computed(() =>
  formatModifiedAtTitle(props.node.modifiedAt, settings.value.appearance.locale),
)
const displayedChildren = computed(() => {
  const entries = props.transformChildren ? props.transformChildren(children.value, props.depth) : children.value
  traceMedia('directory.visible', { panel: props.panelSide, providerId: props.providerId, path: props.node.path,
    children: children.value.length, visible: entries.length, sourceEntries: listingState.sourceEntryCount })
  return entries
})
const terminalPath = computed(() =>
  formatTerminalPath(props.node.path, {
    homePath: props.homePath,
    directory: props.node.isDirectory,
  }),
)

const scrollToSelected = async () => {
  if (!props.scrollSelectedIntoView || !activeSelection.value) {
    return
  }

  await nextTick()
  rowElement.value?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  })
}

const loadChildren = () => listing.load()

const toggle = async () => {
  if (!props.node.isDirectory) {
    return
  }

  expanded.value = !expanded.value
  emit('expanded-change', { path: props.node.path, expanded: expanded.value })

  if (expanded.value) {
    if (isComputerPath(props.node.path)) loaded.value = false
    startDirectoryWatch()
    await loadChildren()
  } else {
    listing.invalidate()
    releaseDirectoryWatch()
  }
}

const selectNode = (event) => {
  emit('select', {
    node: props.node,
    shiftKey: Boolean(event?.shiftKey),
    metaKey: Boolean(event?.metaKey),
    ctrlKey: Boolean(event?.ctrlKey),
  })
}

const handleDoubleClick = () => {
  cancelRenameTimer()
  if (!selected.value) selectNode()
  emit('open', props.node)
}

const handleContextMenu = (event) => {
  cancelRenameTimer()
  event.preventDefault()
  event.stopPropagation()

  if (props.depth === 0) {
    return
  }

  if (!selected.value) selectNode()
  emit('context-menu', {
    node: props.node,
    x: event.clientX,
    y: event.clientY,
  })
}

const forwardOpen = (payload) => {
  if (payload?.node) {
    emit('open', payload)
    return
  }

  emit('open', {
    node: payload,
    siblings: displayedChildren.value,
  })
}

const forwardContextMenu = (payload) => {
  emit('context-menu', payload?.siblings
    ? payload
    : { ...payload, siblings: children.value })
}

const handleKeydown = (event) => {
  if (event.key === 'F2') {
    event.preventDefault()
    selectNode()
    nextTick(beginRename)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    selectNode()
    if (props.node.isDirectory) toggle()
    else emit('open', props.node)
  }

  if (event.key === 'ArrowRight' && props.node.isDirectory && !expanded.value) {
    toggle()
  }

  if (event.key === 'ArrowLeft' && expanded.value) {
    toggle()
  }
}

const handleDragStart = (event) => {
  cancelRenameTimer()
  if (!event.dataTransfer || !terminalPath.value || isComputerPath(props.node.path)) {
    event.preventDefault()
    return
  }

  if (!selected.value) selectNode()
  dragging.value = true
  const operable = props.depth > 0 && !isFilesystemRootEntry(props.node)
  const payload = operable ? createFileDragPayload(
    props.node,
    props.panelSide,
    props.providerId,
    selected.value ? props.selectedEntries : [props.node],
  ) : null

  // Desktop app: a native drag carries real files (local) or file promises /
  // virtual files (SFTP) to Finder and Explorer. Drops back into Vesperwind
  // are resolved by the native layer and use the same operation menu.
  if (operable && runtime.capabilities.externalDragOut) {
    event.preventDefault()
    const session = { ...parseFileDragPayload(payload), terminalPath: terminalPath.value }
    beginNativeDrag(session)
    void externalFiles.startDrag(session.sources || [session]).then((response) => {
      if (response.ok) return
      endNativeDrag()
      dragging.value = false
      if (response.error?.code !== 'EDRAG_ENDED') showNotice('Unable to drag', response.error)
    })
    return
  }

  event.dataTransfer.effectAllowed = 'all'
  if (payload) event.dataTransfer.setData(FILE_ENTRY_MIME, payload)
  event.dataTransfer.setData(TERMINAL_PATH_MIME, terminalPath.value)
  event.dataTransfer.setData('text/plain', terminalPath.value)
}

const handleDragEnd = () => {
  dragging.value = false
}

const handleDragOver = (event) => {
  if (!props.node.isDirectory || isComputerPath(props.node.path) || !fileDropKind(event)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = 'copy'
  dropTarget.value = true
}

const handleDragLeave = (event) => {
  if (event.currentTarget.contains(event.relatedTarget)) {
    return
  }

  dropTarget.value = false
}

const handleDrop = (event) => {
  dropTarget.value = false
  const kind = fileDropKind(event)

  if (!props.node.isDirectory || isComputerPath(props.node.path) || !kind) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  // Our own native drag is resolved by the native layer (native-drag:drop).
  if (kind === 'native') return
  const target = {
    providerId: props.providerId,
    path: props.node.path,
    name: props.node.name,
    isDirectory: true,
  }
  if (kind === 'external') {
    emit('drop-request', {
      external: externalFiles.readDrop(event.dataTransfer),
      target,
      targetPanel: props.panelSide,
      x: event.clientX,
      y: event.clientY,
    })
    return
  }
  const source = parseFileDragPayload(
    event.dataTransfer.getData(FILE_ENTRY_MIME),
  )

  if (
    !source ||
    (source.providerId === props.providerId && source.path === props.node.path)
  ) {
    return
  }

  emit('drop-request', {
    source,
    target,
    targetPanel: props.panelSide,
    x: event.clientX,
    y: event.clientY,
  })
}

watch(() => nativeDrag.active, (active) => {
  if (active) return
  dropTarget.value = false
  dragging.value = false
})

onMounted(() => {
  if (props.defaultExpanded) {
    expanded.value = true
    startDirectoryWatch()
    loadChildren()
  }

  scrollToSelected()
})

watch(() => props.expandedPaths.includes(props.node.path), (included) => {
  if (included && props.node.isDirectory && !expanded.value) void toggle()
})

watch(activeSelection, (isSelected) => {
  if (isSelected) {
    scrollToSelected()
  }
  if (!isSelected) { lastNameClick = 0; cancelRename() }
})

watch(
  () => props.renameRequest,
  async (request) => {
    if (!request || request.path !== props.node.path || props.depth === 0) {
      return
    }

    selectNode()
    await nextTick()
    await beginRename()
  },
)

watch(entryChange, async (change) => {
  if (change?.targetDirectory !== props.node.path || !props.node.isDirectory) return
  await refreshChildren()
})
watch(() => props.watchActive, (active) => {
  if (!active) { listing.invalidate(); releaseDirectoryWatch() }
  else if (expanded.value) { startDirectoryWatch(); void refreshChildren() }
})
watch(() => [props.providerId, props.node.path], () => {
  releaseDirectoryWatch(); listing.reset()
  if (expanded.value) { startDirectoryWatch(); void loadChildren() }
}, { flush: 'sync' })
watch(() => props.refreshRevision, () => { void refreshChildren() })
onBeforeUnmount(() => { listing.dispose(); cancelRenameTimer(); releaseDirectoryWatch() })
</script>

<template>
  <li class="tree-node" role="treeitem" :aria-expanded="node.isDirectory ? expanded : undefined">
    <div
      ref="rowElement"
      class="tree-row"
      :class="{
        'is-compact': compact,
        'is-selected': selected,
        'is-dragging': dragging,
        'is-drop-target': dropTarget,
        'is-cut': cut,
      }"
      :title="node.path"
      :data-file-path="depth > 0 ? node.path : undefined"
      :data-file-name="depth > 0 ? node.name : undefined"
      :data-file-directory="depth > 0 ? String(node.isDirectory) : undefined"
      :data-directory-drop-target="node.isDirectory ? '' : undefined"
      :data-drop-path="node.isDirectory ? node.path : undefined"
      :data-drop-name="node.isDirectory ? node.name : undefined"
      :draggable="!renaming && Boolean(terminalPath)"
      tabindex="0"
      @click="selectNode"
      @dblclick="handleDoubleClick"
      @contextmenu="handleContextMenu"
      @keydown="handleKeydown"
      @dragstart="handleDragStart"
      @dragend="handleDragEnd"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div class="tree-name-cell" :style="rowPadding">
        <button
          v-if="node.isDirectory"
          class="tree-toggle"
          type="button"
          :aria-label="expanded ? `Collapse ${node.name}` : `Expand ${node.name}`"
          :aria-expanded="expanded"
          @click.stop="toggle"
          @dblclick.stop
        >
          <i
            class="mdi"
            :class="loading ? 'mdi-loading mdi-spin' : expanded ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            aria-hidden="true"
          />
        </button>
        <span v-else class="tree-toggle-spacer" />

        <i
          class="mdi tree-file-icon"
          :class="[iconDetails.icon, iconDetails.className]"
          aria-hidden="true"
        />
        <input
          v-if="renaming" ref="renameInput" v-model="renameName" class="tree-rename-input"
          :aria-label="`Rename ${node.name}`" :disabled="renameBusy" :aria-invalid="Boolean(renameError)"
          @click.stop @dblclick.stop @pointerdown.stop @keydown.stop
          @keydown.enter.prevent="submitRename" @keydown.esc.prevent="cancelRename"
          @blur="!renameError && cancelRename()"
        >
        <span v-else class="tree-label" @click="handleNameClick">{{ node.name }}</span>
        <i
          v-if="availabilityBadge"
          class="mdi tree-content-badge"
          :class="availabilityBadge.icon"
          role="img"
          :aria-label="availabilityBadge.label"
          :title="availabilityBadge.label"
        />
        <i
          v-if="node.isSymbolicLink"
          class="mdi mdi-arrow-top-right-thin-circle-outline tree-link-badge"
          aria-label="Symbolic link"
        />
      </div>
      <span v-if="!compact" class="tree-size" :title="formattedSize">{{ formattedSize }}</span>
      <time
        v-if="!compact"
        class="tree-date"
        :datetime="node.modifiedAt || undefined"
        :title="modifiedAtTitle"
      >
        {{ formattedModifiedAt }}
      </time>
    </div>

    <div v-if="renaming && renameError" class="tree-state text-danger" role="alert">{{ renameError }}</div>

    <template v-if="node.isDirectory">
      <div
        v-if="error"
        v-show="expanded"
        class="tree-state tree-error"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 26}px` }"
        role="status"
      >
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        {{ error.message }}
      </div>
      <div
        v-if="loaded && !error && displayedChildren.length === 0"
        v-show="expanded"
        class="tree-state"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 26}px` }"
      >
        {{ listingState.sourceEntryCount > 0 ? 'No items match the current filters' : 'Empty folder' }}
      </div>
      <ul
        v-if="expanded && displayedChildren.length"
        class="tree-children"
        role="group"
      >
        <FileTreeNode
          v-for="child in displayedChildren"
          :key="child.path"
          :node="child"
          :home-path="homePath"
          :panel-side="panelSide"
          :provider-id="providerId"
          :depth="depth + 1"
          :selected-path="selectedPath"
          :selected-paths="selectedPaths"
          :selected-entries="selectedEntries"
          :expanded-paths="expandedPaths"
          :default-expanded="expandedPaths.includes(child.path)"
          :rename-request="renameRequest"
          :list-directory="listDirectory"
          :compact="compact"
          :scroll-selected-into-view="scrollSelectedIntoView"
          :watch-active="watchActive"
          :refresh-revision="refreshRevision"
          :transform-children="transformChildren"
          @select="$emit('select', $event)"
          @open="forwardOpen"
          @drop-request="$emit('drop-request', $event)"
          @context-menu="forwardContextMenu"
          @expanded-change="$emit('expanded-change', $event)"
          @children-loaded="$emit('children-loaded', $event)"
        />
      </ul>
    </template>
  </li>
</template>
