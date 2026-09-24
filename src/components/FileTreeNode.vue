<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { entryNameError } from '../../shared/entryName.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { entryChange } from '../composables/useEntryChanges.js'
import { getFileIcon } from '../utils/fileIcons.js'
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
})

const emit = defineEmits(['select', 'open', 'drop-request', 'context-menu', 'expanded-change', 'children-loaded'])
const { settings } = useSettings()
const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const children = ref([])
const error = ref(null)
const dragging = ref(false)
const dropTarget = ref(false)
const rowElement = ref(null)
const { renameEntry } = useFileOperations(props.providerId)
const renaming = ref(false)
const renameName = ref('')
const renameError = ref('')
const renameBusy = ref(false)
const renameInput = ref(null)
let renameTimer = null
let lastNameClick = 0
let refreshPending = false
const cancelRenameTimer = () => { clearTimeout(renameTimer); renameTimer = null }
const cancelRename = () => {
  if (renameBusy.value) return
  cancelRenameTimer()
  renaming.value = false
  renameError.value = ''
}
const beginRename = async () => {
  if (!selected.value || props.depth === 0 || renameBusy.value) return
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
const rowPadding = computed(() => ({ paddingLeft: `${props.depth * 16 + 6}px` }))
const formattedSize = computed(() =>
  formatFileSize(props.node.size, props.node.isDirectory),
)
const formattedModifiedAt = computed(() =>
  formatModifiedAt(props.node.modifiedAt, settings.value.appearance.locale),
)
const modifiedAtTitle = computed(() =>
  formatModifiedAtTitle(props.node.modifiedAt, settings.value.appearance.locale),
)
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

const loadChildren = async () => {
  if (loaded.value || loading.value || !props.node.isDirectory) {
    return
  }

  loading.value = true
  error.value = null
  const response = await props.listDirectory(props.node.path)
  loading.value = false
  loaded.value = true

  if (refreshPending) {
    refreshPending = false
    loaded.value = false
    if (expanded.value) await loadChildren()
    return
  }

  if (!response?.ok) {
    error.value = response?.error || { message: 'Unable to read this folder' }
    return
  }

  children.value = response.entries
  emit('children-loaded')
}

const toggle = async () => {
  if (!props.node.isDirectory) {
    return
  }

  expanded.value = !expanded.value
  emit('expanded-change', { path: props.node.path, expanded: expanded.value })

  if (expanded.value) {
    await loadChildren()
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
    siblings: children.value,
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
  if (!event.dataTransfer || !terminalPath.value) {
    event.preventDefault()
    return
  }

  if (!selected.value) selectNode()
  dragging.value = true
  event.dataTransfer.effectAllowed = 'all'

  if (props.depth > 0) {
    event.dataTransfer.setData(
      FILE_ENTRY_MIME,
      createFileDragPayload(
        props.node,
        props.panelSide,
        props.providerId,
        selected.value ? props.selectedEntries : [props.node],
      ),
    )
  }

  event.dataTransfer.setData(TERMINAL_PATH_MIME, terminalPath.value)
  event.dataTransfer.setData('text/plain', terminalPath.value)
}

const handleDragEnd = () => {
  dragging.value = false
}

const carriesFileEntry = (event) =>
  Array.from(event.dataTransfer?.types || []).includes(FILE_ENTRY_MIME)

const handleDragOver = (event) => {
  if (!props.node.isDirectory || !carriesFileEntry(event)) {
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

  if (!props.node.isDirectory || !carriesFileEntry(event)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
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
    target: {
      providerId: props.providerId,
      path: props.node.path,
      name: props.node.name,
      isDirectory: true,
    },
    targetPanel: props.panelSide,
    x: event.clientX,
    y: event.clientY,
  })
}

onMounted(() => {
  if (props.defaultExpanded) {
    expanded.value = true
    loadChildren()
  }

  scrollToSelected()
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
  // A pending initial read may contain an old snapshot. Refresh after it settles.
  if (loading.value) {
    refreshPending = true
    return
  }
  loaded.value = false
  if (expanded.value) await loadChildren()
})
onBeforeUnmount(cancelRenameTimer)
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
      }"
      :title="node.path"
      :data-file-path="depth > 0 ? node.path : undefined"
      :data-file-name="depth > 0 ? node.name : undefined"
      :data-file-directory="depth > 0 ? String(node.isDirectory) : undefined"
      :data-directory-drop-target="node.isDirectory ? '' : undefined"
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
        v-else-if="loaded && children.length === 0"
        v-show="expanded"
        class="tree-state"
        :style="{ paddingLeft: `${(depth + 1) * 16 + 26}px` }"
      >
        Empty folder
      </div>
      <ul
        v-else-if="children.length"
        v-show="expanded"
        class="tree-children"
        role="group"
      >
        <FileTreeNode
          v-for="child in children"
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
          @select="$emit('select', $event)"
          @open="forwardOpen"
          @drop-request="$emit('drop-request', $event)"
          @context-menu="forwardContextMenu"
          @expanded-change="$emit('expanded-change', $event)"
          @children-loaded="$emit('children-loaded')"
        />
      </ul>
    </template>
  </li>
</template>
