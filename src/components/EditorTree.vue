<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useFilesystem } from '../composables/useFilesystem.js'
import { buildPathBreadcrumbs } from '../utils/pathBreadcrumbs.js'
import FileTree from './FileTree.vue'
import { entryChange, relocatePath } from '../composables/useEntryChanges.js'

const props = defineProps({
  context: {
    type: Object,
    required: true,
  },
  activeFilePath: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['open-file'])
const { listDirectory } = useFilesystem(props.context.filesystemId)
const selectedPath = ref(
  props.activeFilePath || props.context.sourceRootPath,
)
watch(entryChange, (change) => {
  if (change?.providerId === props.context.filesystemId) {
    selectedPath.value = relocatePath(selectedPath.value, change)
  }
})
const breadcrumbsRef = ref(null)
const root = computed(() => ({
  name:
    props.context.sourceRootName ||
    props.context.sourceRootPath.split('/').filter(Boolean).at(-1) ||
    '/',
  path: props.context.sourceRootPath,
  type: 'directory',
  isDirectory: true,
  isSymbolicLink: false,
  size: null,
  modifiedAt: null,
}))
const breadcrumbs = computed(() =>
  buildPathBreadcrumbs(props.context.filesystemRoot, props.context.sourceRootPath),
)

const openNode = (payload) => {
  const node = payload?.node || payload

  if (!node || node.isDirectory) {
    return
  }

  emit('open-file', {
    node,
    siblings: Array.isArray(payload?.siblings) ? payload.siblings : [node],
    filesystemId: props.context.filesystemId,
    sourcePane: props.context.sourcePane,
    sourceRootPath: props.context.sourceRootPath,
    sourceRootName: props.context.sourceRootName,
    filesystemRoot: props.context.filesystemRoot,
    homePath: props.context.homePath,
  })
}

watch(
  () => props.context.sourceRootPath,
  async (path) => {
    if (!props.activeFilePath) {
      selectedPath.value = path
    }

    await nextTick()

    if (breadcrumbsRef.value) {
      breadcrumbsRef.value.scrollLeft = breadcrumbsRef.value.scrollWidth
    }
  },
  { immediate: true },
)

watch(
  () => props.activeFilePath,
  (path) => {
    if (path) {
      selectedPath.value = path
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="editor-tree" :aria-label="`${context.sourcePane} editor tree`">
    <header class="editor-tree-header">
      <i class="mdi mdi-file-tree-outline" aria-hidden="true" />
      <nav ref="breadcrumbsRef" class="panel-breadcrumbs" aria-label="Editor tree root path">
        <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
          <i v-if="index" class="mdi mdi-chevron-right breadcrumb-separator" aria-hidden="true" />
          <span class="editor-path-segment" :title="crumb.path">{{ crumb.name }}</span>
        </template>
      </nav>
    </header>
    <div class="editor-tree-content">
      <FileTree
        :root="root"
        :home-path="context.homePath"
        :provider-id="context.filesystemId"
        :panel-side="context.sourcePane"
        :selected-path="selectedPath"
        :list-directory="listDirectory"
        scroll-selected-into-view
        compact
        @select="selectedPath = $event.path"
        @open="openNode"
      />
    </div>
  </section>
</template>
