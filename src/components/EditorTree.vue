<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useFilesystem } from '../composables/useFilesystem.js'
import { buildPathBreadcrumbs } from '../utils/pathBreadcrumbs.js'
import FileTree from './FileTree.vue'
import FolderPathMenu from './FolderPathMenu.vue'
import SearchResults from './SearchResults.vue'
import { useRecursiveSearch } from '../composables/useRecursiveSearch.js'
import { buildFilesystemPathLevels, getFilesystemPathName, isSameOrDescendantPath } from '../utils/filesystemPath.js'
import { currentChildPath } from '../utils/folderMenu.js'
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
  watchActive: { type: Boolean, default: true },
})

const emit = defineEmits(['open-file'])
const { listDirectory } = useFilesystem(props.context.filesystemId)
const selectedPath = ref(
  props.activeFilePath || props.context.sourceRootPath,
)
const expandedPaths = ref([])
// The folder shown by this tree. Breadcrumb navigation changes only this view;
// tabs keep their source context, so tree grouping in the workspace is unchanged.
const browsedPath = ref(props.context.sourceRootPath)
const { search, results: searchResults, start: startSearch, cancel: cancelSearch, clear: clearSearch } = useRecursiveSearch()
const runSearch = () => startSearch({ providerId: props.context.filesystemId, basePath: browsedPath.value })
const revealResult = (node) => {
  const levels = buildFilesystemPathLevels(browsedPath.value, node.path)
  expandedPaths.value = [...new Set([...expandedPaths.value, ...levels.slice(0, -1), ...(node.isDirectory ? [node.path] : [])])]
  selectedPath.value = node.path
  clearSearch()
}
const openResult = (node) => { if (node.isDirectory) revealResult(node); else { openNode(node); clearSearch() } }
const updateExpanded = ({ path, expanded }) => {
  expandedPaths.value = expanded
    ? [...new Set([...expandedPaths.value, path])]
    : expandedPaths.value.filter((value) => value !== path)
}
watch(entryChange, (change) => {
  if (change?.providerId === props.context.filesystemId) {
    selectedPath.value = relocatePath(selectedPath.value, change)
    browsedPath.value = relocatePath(browsedPath.value, change)
  }
})
const breadcrumbsRef = ref(null)
const root = computed(() => ({
  name: browsedPath.value === props.context.sourceRootPath
    ? props.context.sourceRootName ||
      props.context.sourceRootPath.split('/').filter(Boolean).at(-1) ||
      '/'
    : getFilesystemPathName(browsedPath.value) || browsedPath.value,
  path: browsedPath.value,
  type: 'directory',
  isDirectory: true,
  isSymbolicLink: false,
  size: null,
  modifiedAt: null,
}))
const breadcrumbs = computed(() =>
  buildPathBreadcrumbs(props.context.filesystemRoot, browsedPath.value),
)

const folderMenu = ref(null)
let folderMenuSequence = 0
const browse = (path) => {
  folderMenu.value = null
  if (!path || path === browsedPath.value) return
  clearSearch()
  browsedPath.value = path
  expandedPaths.value = expandedPaths.value.filter((value) => isSameOrDescendantPath(path, value))
}
const openFolderMenu = (event, crumb, index) => {
  const rect = event.currentTarget.getBoundingClientRect()
  folderMenu.value = {
    id: ++folderMenuSequence,
    path: crumb.path,
    name: crumb.name,
    anchor: { left: rect.left, bottom: rect.bottom },
    currentPath: currentChildPath(breadcrumbs.value, index),
  }
}

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

watch(() => props.context.filesystemId, cancelSearch)
watch(
  () => props.context.sourceRootPath,
  async (path) => {
    browsedPath.value = path
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

watch(browsedPath, async () => {
  await nextTick()
  if (breadcrumbsRef.value) breadcrumbsRef.value.scrollLeft = breadcrumbsRef.value.scrollWidth
})

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
          <button
            class="path-segment"
            :class="{ 'is-current': index === breadcrumbs.length - 1 }"
            type="button"
            :title="crumb.path"
            aria-haspopup="menu"
            :aria-expanded="folderMenu?.path === crumb.path"
            :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined"
            @click="browse(crumb.path)"
            @contextmenu.prevent.stop="openFolderMenu($event, crumb, index)"
          >{{ crumb.name }}</button>
        </template>
      </nav>
      <FolderPathMenu
        v-if="folderMenu"
        :key="folderMenu.id"
        :request="folderMenu"
        :list-directory="listDirectory"
        @select="browse($event.path)"
        @cancel="folderMenu = null"
      />
      <button class="editor-tree-toggle compact-icon-button" type="button" title="Search workspace" aria-label="Search workspace" @click="search.open ? clearSearch() : (search.open = true)"><i class="mdi mdi-magnify" aria-hidden="true" /></button>
    </header>
    <form v-if="search.open" class="search-controls" role="search" @submit.prevent="runSearch" @keydown.esc.prevent="clearSearch">
      <input v-model="search.query" class="form-control form-control-sm" aria-label="Search workspace files" placeholder="Search files" @input="cancelSearch">
      <select v-model="search.type" class="form-select form-select-sm" aria-label="Search type" @change="cancelSearch"><option value="all">All</option><option value="files">Files</option><option value="folders">Folders</option></select>
      <button class="btn btn-sm btn-primary" type="submit" title="Start search"><i class="mdi mdi-magnify" aria-hidden="true" /></button>
    </form>
    <div class="editor-tree-content">
      <div v-if="search.open" class="editor-search-results">
        <div class="search-status" role="status">{{ search.status === 'searching' ? `Searching… ${searchResults.length} found` : search.error || (search.limited ? '10,000+ results — refine your search' : `${searchResults.length} results`) }}</div>
        <SearchResults :results="searchResults" compact @open="openResult" @reveal="revealResult" />
      </div>
      <FileTree v-show="!search.open"
        :root="root"
        :home-path="context.homePath"
        :provider-id="context.filesystemId"
        :panel-side="context.sourcePane"
        :selected-path="selectedPath"
        :expanded-paths="expandedPaths"
        :list-directory="listDirectory"
        :watch-active="watchActive"
        scroll-selected-into-view
        compact
        @select="selectedPath = $event.path"
        @open="openNode"
        @expanded-change="updateExpanded"
      />
    </div>
  </section>
</template>
