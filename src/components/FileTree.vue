<script setup>
import FileTreeNode from './FileTreeNode.vue'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'

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
  providerId: {
    type: String,
    default: LOCAL_FILESYSTEM_PROVIDER,
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

defineEmits(['select', 'open', 'drop-request'])
</script>

<template>
  <ul class="file-tree" role="tree" aria-label="Filesystem tree">
    <FileTreeNode
      :node="root"
      :home-path="homePath"
      :panel-side="panelSide"
      :provider-id="providerId"
      :selected-path="selectedPath"
      :list-directory="listDirectory"
      :compact="compact"
      :scroll-selected-into-view="scrollSelectedIntoView"
      default-expanded
      @select="$emit('select', $event)"
      @open="$emit('open', $event)"
      @drop-request="$emit('drop-request', $event)"
    />
  </ul>
</template>
