<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import FileTreeNode from './FileTreeNode.vue'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'
import { cloudStatus } from '../api/cloudStatus.js'
import { createDirectoryTree } from '../composables/useDirectoryTree.js'
import { createVirtualViewport } from '../composables/useVirtualViewport.js'
import { entryChange } from '../composables/useEntryChanges.js'
import { useFileOperations } from '../composables/useFileOperations.js'
import { computeVirtualRange } from '../utils/virtualRange.js'
import { entryNameError } from '../../shared/entryName.js'
import { isFilesystemRootEntry } from '../../shared/localFilesystem.js'
import { FILE_TREE_KEY } from '../utils/fileTreeContext.js'

const props = defineProps({
  root: {
    type: Object,
    required: true,
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
  watchActive: { type: Boolean, default: true },
  refreshRevision: { type: Number, default: 0 },
  transformChildren: { type: Function, default: null },
})

const emit = defineEmits(['select', 'open', 'drop-request', 'context-menu', 'expanded-change', 'children-loaded'])

const listRef = ref(null)
const { viewport, attach, detach, measure, scrollToIndex } = createVirtualViewport()
const range = computed(() => computeVirtualRange({ count: tree.rows.value.length, rowHeight: viewport.rowHeight,
  scrollTop: viewport.scrollTop, viewportHeight: viewport.height, offset: viewport.offset, inset: viewport.inset }))

// Cloud status of a folder follows the viewport: rows on screen first, then
// the ones closest to them. Read when each batch is chosen, not per scroll.
const statusPriority = (directoryPath) => {
  const { first, last } = range.value
  const center = (first + Math.max(first, last)) / 2
  const index = tree.flat.value.indexByPath
  return tree.displayedOf(directoryPath)
    .map((entry) => ({ entry, distance: Math.abs((index.get(entry.path) ?? Infinity) - center) }))
    .sort((left, right) => left.distance - right.distance)
    .map(({ entry }) => entry)
}

const tree = createDirectoryTree({
  getRoot: () => props.root,
  getProviderId: () => props.providerId,
  listDirectory: (path, options) => props.listDirectory(path, options),
  transformChildren: (entries, depth) => (props.transformChildren ? props.transformChildren(entries, depth) : entries),
  getExpandedPaths: () => props.expandedPaths,
  isWatchActive: () => props.watchActive,
  cloudStatus,
  statusPriority,
  consumer: props.panelSide,
  onChildrenLoaded: (payload) => emit('children-loaded', payload),
  onExpandedChange: (payload) => emit('expanded-change', payload),
})

const rows = tree.rows
const mountedRows = computed(() => rows.value.slice(range.value.start, range.value.end))
const topSpace = computed(() => range.value.start * viewport.rowHeight)
const bottomSpace = computed(() => (rows.value.length - range.value.end) * viewport.rowHeight)
const selectedSet = computed(() => new Set(props.selectedPaths))
const isSelected = (row) => selectedSet.value.has(row.entry.path) ||
  (row.depth === 0 && props.selectedPath === row.entry.path)
// One tab stop: the active row, else the first row.
const focusPath = computed(() => (tree.indexOf(props.selectedPath) >= 0 ? props.selectedPath : rows.value[0]?.entry?.path))

const entryRows = () => rows.value.filter((row) => row.kind === 'entry' && row.depth > 0)
/** Every logically shown entry in display order, mounted or not. */
const visibleEntries = () => entryRows().map((row) => ({ ...row.entry, providerId: props.providerId }))

const rowElement = (path) => listRef.value?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`)
/** Scroll the logical row into view, wait for it to mount, optionally focus it. */
const revealPath = async (path, { focus = false, block = 'nearest' } = {}) => {
  const index = tree.indexOf(path)
  if (index < 0) return null
  scrollToIndex(index, block)
  await nextTick()
  const element = rowElement(path)
  if (focus) element?.focus({ preventScroll: true })
  return element
}

const { renameEntry } = useFileOperations(props.providerId)
const startRename = async (entry) => {
  if (!entry || isFilesystemRootEntry(entry) || tree.rename.busy) return
  tree.beginRename(entry)
  await revealPath(entry.path)
}
const cancelRename = () => tree.cancelRename()
const submitRename = async () => {
  const { rename } = tree
  if (!rename.path || rename.busy) return
  const entry = rows.value[tree.indexOf(rename.path)]?.entry
  rename.error = entryNameError(rename.draft)
  if (rename.error) return
  if (!entry || rename.draft === entry.name) { cancelRename(); return }
  rename.busy = true
  try {
    const response = await renameEntry(rename.path, rename.draft)
    rename.busy = false
    if (response.ok) cancelRename()
    else rename.error = response.error.message
  } catch (error) {
    rename.busy = false
    rename.error = error.message || 'Unable to rename this item'
  }
}

const toggleRow = (row) => tree.toggle(row.entry, row.depth)
const openRow = (row) => emit('open', { node: row.entry, siblings: row.depth > 0 ? tree.displayedOf(row.parentPath) : [row.entry] })
const contextMenuRow = (row, payload) => emit('context-menu', { ...payload, siblings: tree.childrenOf(row.parentPath) })

provide(FILE_TREE_KEY, { tree, startRename, submitRename, cancelRename })

// Arrow keys move through the logical tree, including rows that are not mounted.
const moveSelection = async (event, target) => {
  const entries = entryRows()
  if (!entries.length) return
  const bounded = Math.max(0, Math.min(entries.length - 1, target))
  const row = entries[bounded]
  event.preventDefault()
  emit('select', { node: row.entry, shiftKey: event.shiftKey, metaKey: false, ctrlKey: false })
  await revealPath(row.entry.path, { focus: true })
}
const handleTreeKeydown = (event) => {
  if (event.target.closest?.('input, textarea') || event.altKey || event.metaKey || event.ctrlKey) return
  const entries = entryRows()
  const current = entries.findIndex((row) => row.entry.path === props.selectedPath)
  const page = Math.max(1, Math.floor((viewport.height - viewport.inset) / viewport.rowHeight) - 1)
  const moves = { ArrowDown: current + 1, ArrowUp: current < 0 ? 0 : current - 1, Home: 0, End: entries.length - 1,
    PageDown: current + page, PageUp: current - page }
  if (event.key in moves) void moveSelection(event, moves[event.key])
}

watch(() => props.renameRequest, async (request) => {
  if (!request) return
  const row = rows.value[tree.indexOf(request.path)]
  if (!row || row.depth === 0) return
  emit('select', { node: row.entry })
  await nextTick()
  await startRename(row.entry)
})
// Leaving the row ends its rename, wherever the row currently is.
watch(() => props.selectedPath, (path) => { if (tree.rename.path && path !== tree.rename.path) cancelRename() })

let revealedSelection = ''
watch([() => props.selectedPath, () => rows.value], ([path]) => {
  if (!props.scrollSelectedIntoView || !path || revealedSelection === path || tree.indexOf(path) < 0) return
  revealedSelection = path
  void revealPath(path)
}, { flush: 'post' })
watch(() => props.selectedPath, () => { revealedSelection = '' }, { flush: 'sync' })

watch(entryChange, (change) => {
  if (change?.providerId === props.providerId && change.targetDirectory && tree.isExpanded(change.targetDirectory)) {
    void tree.refreshDirectory(change.targetDirectory)
  }
})
watch(() => props.watchActive, (active) => tree.setWatchActive(active))
watch(() => props.refreshRevision, () => tree.refreshExpanded())
watch(() => props.expandedPaths, () => tree.syncExpanded())
watch(() => props.transformChildren, () => tree.syncExpanded())
// Re-root only when the location changes, not when a parent re-renders the
// same root as a new object.
watch(() => `${props.providerId}\0${props.root?.path}`, () => tree.resetRoot())
// Content above the list (a loading message) can move it; re-measure once
// the row count changes, not on scroll.
watch(() => rows.value.length, () => nextTick(measure))

// The dragged row may scroll out of the window; the drag itself ends globally.
const endDrag = () => { tree.drag.path = '' }
onMounted(() => {
  attach(listRef.value)
  tree.resetRoot()
  window.addEventListener('dragend', endDrag)
  window.addEventListener('drop', endDrag)
})
onBeforeUnmount(() => {
  detach()
  tree.dispose()
  window.removeEventListener('dragend', endDrag)
  window.removeEventListener('drop', endDrag)
})

defineExpose({ visibleEntries, revealPath, tree })
</script>

<template>
  <ul
    ref="listRef"
    class="file-tree"
    role="tree"
    aria-label="Filesystem tree"
    :aria-multiselectable="compact ? undefined : 'true'"
    @keydown="handleTreeKeydown"
  >
    <li v-if="topSpace" class="tree-spacer" role="none" aria-hidden="true" :style="{ height: `${topSpace}px` }" />
    <template v-for="row in mountedRows" :key="row.key">
      <FileTreeNode
        v-if="row.kind === 'entry'"
        :node="row.entry"
        :depth="row.depth"
        :expanded="row.expanded"
        :pos-in-set="row.posInSet"
        :set-size="row.setSize"
        :loading="row.entry.isDirectory && tree.loadingOf(row.entry.path)"
        :selected="isSelected(row)"
        :active="selectedPath === row.entry.path"
        :focusable="focusPath === row.entry.path"
        :selected-entries="selectedEntries"
        :home-path="homePath"
        :panel-side="panelSide"
        :provider-id="providerId"
        :compact="compact"
        @select="$emit('select', $event)"
        @open="openRow(row)"
        @toggle="toggleRow(row)"
        @drop-request="$emit('drop-request', $event)"
        @context-menu="contextMenuRow(row, $event)"
      />
      <li v-else class="tree-node" role="none">
        <div
          v-if="row.kind === 'rename-error'"
          class="tree-state text-danger"
          role="alert"
        >
          {{ row.message }}
        </div>
        <div
          v-else
          class="tree-state"
          :class="{ 'tree-error': row.kind === 'error' }"
          :style="{ paddingLeft: `${row.depth * 16 + 26}px` }"
          :role="row.kind === 'error' ? 'status' : undefined"
        >
          <i v-if="row.kind === 'error'" class="mdi mdi-alert-outline" aria-hidden="true" />
          {{ row.message }}
        </div>
      </li>
    </template>
    <li v-if="bottomSpace" class="tree-spacer" role="none" aria-hidden="true" :style="{ height: `${bottomSpace}px` }" />
  </ul>
</template>
