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
  listDirectory: {
    type: Function,
    required: true,
  },
})

defineEmits(['select'])
</script>

<template>
  <ul class="file-tree" role="tree" aria-label="Filesystem tree">
    <FileTreeNode
      :node="root"
      :selected-path="selectedPath"
      :list-directory="listDirectory"
      default-expanded
      @select="$emit('select', $event)"
    />
  </ul>
</template>
