<script setup>
// One row of the virtual file tree. Folder contents, expansion, watchers,
// cloud status and the rename draft live in the tree state (FileTree), so a
// row can be unmounted by scrolling at any time without losing anything.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isComputerPath, isFilesystemRootEntry } from '../../shared/localFilesystem.js'
import { getFileIcon } from '../utils/fileIcons.js'
import { getFileStatusBadge } from '../utils/contentAvailability.js'
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
import { runtime } from '../api/runtime.js'
import { externalFiles } from '../api/shellIntegration.js'
import { useFileClipboard } from '../composables/useFileClipboard.js'
import { showNotice } from '../composables/useNotice.js'
import { isCutEntry } from '../utils/fileClipboard.js'
import { fileDropKind } from '../utils/fileDrop.js'
import { beginNativeDrag, endNativeDrag, nativeDrag } from '../utils/nativeDragSession.js'
import { FILE_TREE_KEY } from '../utils/fileTreeContext.js'

const props = defineProps({
  node: {
    type: Object,
    required: true,
  },
  depth: {
    type: Number,
    default: 0,
  },
  expanded: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  focusable: { type: Boolean, default: false },
  posInSet: { type: Number, default: 1 },
  setSize: { type: Number, default: 1 },
  selectedEntries: {
    type: Array,
    default: () => [],
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
  compact: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['select', 'open', 'toggle', 'drop-request', 'context-menu', 'open-git'])
const { tree, startRename, submitRename, cancelRename, keepFocus } = inject(FILE_TREE_KEY)
const { settings } = useSettings()
const dropTarget = ref(false)
const { state: clipboardState } = useFileClipboard()
const cut = computed(() => props.depth > 0 &&
  isCutEntry(clipboardState.snapshot, { providerId: props.providerId, path: props.node.path }))
const rowElement = ref(null)
const renameInput = ref(null)
const rename = tree.rename
const renaming = computed(() => props.depth > 0 && rename.path === props.node.path)
const dragging = computed(() => tree.drag.path === props.node.path)
let renameTimer = null
let lastNameClick = 0
let unmounting = false

const selected = computed(() => props.selected)
const iconDetails = computed(() => getFileIcon(props.node, props.expanded))
const statusBadge = computed(() => getFileStatusBadge(props.node, props.providerId))
const rowPadding = computed(() => ({ paddingLeft: `calc(var(--file-tree-row-padding) + ${props.depth} * var(--file-tree-indent))` }))
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

const cancelRenameTimer = () => { clearTimeout(renameTimer); renameTimer = null }
const beginRename = async () => {
  if (!selected.value || props.depth === 0 || isFilesystemRootEntry(props.node) || rename.busy) return
  await startRename(props.node)
}
// The draft lives in the tree state; a remounted row picks up the text and
// the caret where the user left them.
const focusRenameInput = async () => {
  await nextTick()
  const input = renameInput.value
  if (!input) return
  input.focus({ preventScroll: true })
  if (rename.selectionStart !== null) {
    input.setSelectionRange(rename.selectionStart, rename.selectionEnd)
    return
  }
  const dot = props.node.isDirectory ? -1 : props.node.name.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : props.node.name.length)
}
const rememberCaret = (event) => {
  rename.selectionStart = event.target.selectionStart
  rename.selectionEnd = event.target.selectionEnd
}
const handleRenameBlur = () => {
  // Scrolling the row away is not leaving the rename.
  if (unmounting || rename.error) return
  cancelRename()
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

const selectNode = (event) => {
  emit('select', {
    node: props.node,
    shiftKey: Boolean(event?.shiftKey),
    metaKey: Boolean(event?.metaKey),
    ctrlKey: Boolean(event?.ctrlKey),
  })
}

const toggle = () => {
  if (props.node.isDirectory) emit('toggle')
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

const handleKeydown = (event) => {
  if (event.key === 'F2') {
    event.preventDefault()
    selectNode()
    nextTick(beginRename)
    return
  }
  if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    selectNode()
    if (props.node.isDirectory) toggle()
    else emit('open', props.node)
  }

  if (event.key === 'ArrowRight' && props.node.isDirectory && !props.expanded) {
    toggle()
  }

  if (event.key === 'ArrowLeft' && props.expanded) {
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
  tree.drag.path = props.node.path
  const operable = props.depth > 0 && !isFilesystemRootEntry(props.node)
  // Selected entries come from the panel state, never from mounted rows.
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
      tree.drag.path = ''
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
  tree.drag.path = ''
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
  tree.drag.path = ''
})

watch(renaming, (value) => { if (value) void focusRenameInput() })
watch(() => props.active, (isActive) => { if (!isActive) lastNameClick = 0 })

onMounted(() => {
  if (renaming.value) void focusRenameInput()
})
onBeforeUnmount(() => { unmounting = true; cancelRenameTimer(); keepFocus(rowElement.value) })
</script>

<template>
  <li
    class="tree-node"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-expanded="node.isDirectory ? expanded : undefined"
    :aria-selected="selected"
    :aria-posinset="posInSet"
    :aria-setsize="setSize"
    :aria-label="node.name"
  >
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
      :data-tree-path="node.path"
      :data-file-path="depth > 0 ? node.path : undefined"
      :data-file-name="depth > 0 ? node.name : undefined"
      :data-file-directory="depth > 0 ? String(node.isDirectory) : undefined"
      :data-directory-drop-target="node.isDirectory ? '' : undefined"
      :data-drop-path="node.isDirectory ? node.path : undefined"
      :data-drop-name="node.isDirectory ? node.name : undefined"
      :draggable="!renaming && Boolean(terminalPath)"
      :tabindex="focusable ? 0 : -1"
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
          tabindex="-1"
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
          v-if="renaming" ref="renameInput" v-model="rename.draft" class="tree-rename-input"
          :aria-label="`Rename ${node.name}`" :disabled="rename.busy" :aria-invalid="Boolean(rename.error)"
          @click.stop @dblclick.stop @pointerdown.stop @keydown.stop
          @keydown.enter.prevent="submitRename" @keydown.esc.prevent="cancelRename"
          @select="rememberCaret" @keyup="rememberCaret" @input="rememberCaret"
          @blur="handleRenameBlur"
        >
        <span v-else class="tree-label" @click="handleNameClick">{{ node.name }}</span>

        <i
          v-if="node.isSymbolicLink"
          class="mdi mdi-arrow-top-right-thin-circle-outline tree-link-badge"
          aria-label="Symbolic link"
        />
      </div>
      <span class="tree-status-cell">
        <button v-if="providerId === 'local' && node.gitRepository && !renaming" class="compact-icon-button git-repository-button" type="button"
          :title="`Open Git for ${node.name}`" :aria-label="`Open Git for ${node.name}`"
          @dragstart.prevent.stop @pointerdown.stop @click.stop="cancelRenameTimer(); $emit('open-git', node.gitRepository)" @dblclick.stop @keydown.stop>
          <i class="mdi mdi-git" aria-hidden="true" />
        </button>
        <i
          v-else-if="statusBadge"
          class="mdi tree-content-badge"
          :class="[statusBadge.icon, statusBadge.className]"
          role="img"
          :aria-label="statusBadge.label"
          :title="statusBadge.label"
        />
      </span>
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
  </li>
</template>
