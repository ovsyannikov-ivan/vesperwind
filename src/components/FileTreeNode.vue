<script setup>
import { computed, onMounted, ref } from 'vue'
import { getFileIcon } from '../utils/fileIcons.js'

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
  defaultExpanded: {
    type: Boolean,
    default: false,
  },
  listDirectory: {
    type: Function,
    required: true,
  },
})

const emit = defineEmits(['select'])
const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const children = ref([])
const error = ref(null)

const selected = computed(() => props.selectedPath === props.node.path)
const iconDetails = computed(() => getFileIcon(props.node, expanded.value))
const rowPadding = computed(() => ({ paddingLeft: `${props.depth * 16 + 6}px` }))

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
  toggle()
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

onMounted(() => {
  if (props.defaultExpanded) {
    expanded.value = true
    loadChildren()
  }
})
</script>

<template>
  <li class="tree-node" role="treeitem" :aria-expanded="node.isDirectory ? expanded : undefined">
    <div
      class="tree-row"
      :class="{ 'is-selected': selected }"
      :style="rowPadding"
      :title="node.path"
      tabindex="0"
      @click="selectNode"
      @dblclick="handleDoubleClick"
      @keydown="handleKeydown"
    >
      <button
        v-if="node.isDirectory"
        class="tree-toggle"
        type="button"
        :aria-label="expanded ? `Collapse ${node.name}` : `Expand ${node.name}`"
        :aria-expanded="expanded"
        @click.stop="toggle"
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
          :depth="depth + 1"
          :selected-path="selectedPath"
          :list-directory="listDirectory"
          @select="$emit('select', $event)"
        />
      </ul>
    </template>
  </li>
</template>
