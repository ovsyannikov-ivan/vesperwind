<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
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
  homePath: {
    type: String,
    default: '',
  },
  panelSide: {
    type: String,
    required: true,
    validator: (value) => ['left', 'right'].includes(value),
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

const emit = defineEmits(['select', 'open', 'drop-request'])
const { settings } = useSettings()
const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const children = ref([])
const error = ref(null)
const dragging = ref(false)
const dropTarget = ref(false)
const rowElement = ref(null)

const selected = computed(() => props.selectedPath === props.node.path)
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
  if (!props.scrollSelectedIntoView || !selected.value) {
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

  if (!response?.ok) {
    error.value = response?.error || { message: 'Unable to read this folder' }
    return
  }

  children.value = response.entries
}

const toggle = async () => {
  if (!props.node.isDirectory) {
    return
  }

  expanded.value = !expanded.value

  if (expanded.value) {
    await loadChildren()
  }
}

const selectNode = () => {
  emit('select', props.node)
}

const handleDoubleClick = () => {
  selectNode()
  emit('open', props.node)
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

const handleKeydown = (event) => {
  if (event.key === 'Enter') {
    selectNode()
    toggle()
  }

  if (event.key === 'ArrowRight' && props.node.isDirectory && !expanded.value) {
    toggle()
  }

  if (event.key === 'ArrowLeft' && expanded.value) {
    toggle()
  }
}

const handleDragStart = (event) => {
  if (!event.dataTransfer || !terminalPath.value) {
    event.preventDefault()
    return
  }

  selectNode()
  dragging.value = true
  event.dataTransfer.effectAllowed = 'all'

  if (props.depth > 0) {
    event.dataTransfer.setData(
      FILE_ENTRY_MIME,
      createFileDragPayload(props.node, props.panelSide),
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

  if (!source || source.path === props.node.path) {
    return
  }

  emit('drop-request', {
    source,
    target: {
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

watch(selected, (isSelected) => {
  if (isSelected) {
    scrollToSelected()
  }
})
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
      :draggable="Boolean(terminalPath)"
      tabindex="0"
      @click="selectNode"
      @dblclick="handleDoubleClick"
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
        <span class="tree-label">{{ node.name }}</span>
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
          :depth="depth + 1"
          :selected-path="selectedPath"
          :list-directory="listDirectory"
          :compact="compact"
          :scroll-selected-into-view="scrollSelectedIntoView"
          @select="$emit('select', $event)"
          @open="forwardOpen"
          @drop-request="$emit('drop-request', $event)"
        />
      </ul>
    </template>
  </li>
</template>
