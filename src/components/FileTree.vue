<script setup>
import FileTreeNode from './FileTreeNode.vue'

defineProps({
  root: {
    type: Object,
    required: true,
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
  listDirectory: {
    type: Function,
    required: true,
  },
  compact: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['select', 'open', 'drop-request'])
</script>

<template>
  <ul class="file-tree" role="tree" aria-label="Filesystem tree">
    <FileTreeNode
      :node="root"
      :home-path="homePath"
      :panel-side="panelSide"
      :selected-path="selectedPath"
      :list-directory="listDirectory"
      :compact="compact"
      default-expanded
      @select="$emit('select', $event)"
      @open="$emit('open', $event)"
      @drop-request="$emit('drop-request', $event)"
    />
  </ul>
</template>
