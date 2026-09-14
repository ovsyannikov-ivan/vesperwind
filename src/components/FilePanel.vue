<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useFilesystem } from '../composables/useFilesystem.js'
import { useSettings } from '../composables/useSettings.js'
import { buildPathBreadcrumbs } from '../utils/pathBreadcrumbs.js'
import FileTree from './FileTree.vue'

const props = defineProps({
  side: {
    type: String,
    required: true,
    validator: (value) => ['left', 'right'].includes(value),
  },
  active: {
    type: Boolean,
    default: false,
  },
  filesystemRevision: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits([
  'activate',
  'collapse',
  'drop-request',
  'open-file',
  'state-change',
])
const { getRoot, listDirectory } = useFilesystem()
const { revision: settingsRevision } = useSettings()
const filesystemRoot = ref(null)
const homePath = ref('')
const root = ref(null)
const selectedNode = ref(null)
const selectedPath = ref('')
const loading = ref(true)
const error = ref(null)
const breadcrumbsRef = ref(null)
const breadcrumbs = computed(() =>
  buildPathBreadcrumbs(filesystemRoot.value, root.value?.path),
)
const panelState = computed(() => ({
  side: props.side,
  currentDirectory: root.value,
  selected: selectedNode.value,
  canOperateSelected: Boolean(
    selectedNode.value &&
      filesystemRoot.value &&
      selectedNode.value.path !== filesystemRoot.value.path,
  ),
}))

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
  root.value = response.root
  selectedNode.value = response.root
  selectedPath.value = response.root.path
}

const selectNode = (node) => {
  selectedNode.value = node
  selectedPath.value = node.path
}

const openDirectory = (node) => {
  if (!node?.isDirectory) {
    return
  }

  root.value = node
  selectedNode.value = node
  selectedPath.value = node.path
}

const openNode = (payload) => {
  const node = payload?.node || payload

  if (node?.isDirectory) {
    openDirectory(node)
  } else if (node) {
    emit('open-file', {
      node,
      siblings: Array.isArray(payload?.siblings) ? payload.siblings : [node],
      filesystemId: 'local',
      sourcePane: props.side,
      sourceRootPath: root.value?.path,
      sourceRootName: root.value?.name,
      filesystemRoot: filesystemRoot.value,
      homePath: homePath.value,
    })
  }
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
  { immediate: true },
)

watch(
  () => props.filesystemRevision,
  () => {
    if (root.value) {
      selectedNode.value = root.value
      selectedPath.value = root.value.path
    }
  },
)

onMounted(loadRoot)
</script>

<template>
  <section
    class="file-panel"
    :class="{ 'is-active': active }"
    :aria-label="`${side} file panel`"
    @pointerdown="$emit('activate')"
  >
    <header class="panel-header">
      <div class="panel-title">
        <i class="mdi mdi-folder-multiple-outline" aria-hidden="true" />
        <strong>{{ side === 'left' ? 'Left' : 'Right' }}</strong>
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

    <div class="panel-content">
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
          :panel-side="side"
          :selected-path="selectedPath"
          :list-directory="listDirectory"
          @select="selectNode"
          @open="openNode"
          @drop-request="$emit('drop-request', $event)"
        />
      </div>
    </div>
  </section>
</template>
