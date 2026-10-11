import { computed, effectScope, reactive, shallowReactive } from 'vue'
import { isComputerPath } from '../../shared/localFilesystem.js'
import { createDirectoryListing } from '../utils/directoryListing.js'
import { flattenTree } from '../utils/flattenTree.js'
import { isSameOrDescendantPath, normalizeFilesystemPath } from '../utils/filesystemPath.js'
import { directoryWatch } from '../api/directoryWatch.js'

// Folders that were loaded and then collapsed keep their contents for a quick
// re-open, up to this many; older ones are released.
export const COLLAPSED_DIRECTORY_LIMIT = 64

/**
 * The long-lived state of one file tree (one panel or editor sidebar): loaded
 * folders, expansion, watchers, lazy cloud status and rename. Rows are only a
 * view of it, so mounting or unmounting a row never loads, refreshes or drops
 * folder data. Distinct events have distinct effects:
 * - a row leaving the viewport: nothing;
 * - collapsing a folder: stop its listing, watcher and scan, release its
 *   descendants, keep its own contents (bounded);
 * - deactivating the tree: stop requests and watchers, keep everything;
 * - disposing the tree: release everything.
 */
export const createDirectoryTree = ({
  getRoot,
  getProviderId,
  listDirectory,
  transformChildren = () => null,
  getExpandedPaths = () => [],
  isWatchActive = () => true,
  cloudStatus = null,
  statusPriority = () => [],
  consumer = 'tree',
  watchRegistry = directoryWatch,
  onChildrenLoaded = () => {},
  onExpandedChange = () => {},
} = {}) => {
  const scope = effectScope(true)
  // key -> record. Shallow: adding or removing a folder re-flattens the tree.
  const records = shallowReactive(new Map())
  const expanded = reactive(new Set())
  const collapsedOrder = []
  const rename = reactive({ path: '', draft: '', error: '', busy: false, selectionStart: null, selectionEnd: null })
  const drag = reactive({ path: '' })
  let disposed = false

  const keyOf = (path) => `${getProviderId()}\0${normalizeFilesystemPath(path)}`
  const recordOf = (path) => (path ? records.get(keyOf(path)) : undefined)

  const stopWatch = (record) => { record.stopWatch?.(); record.stopWatch = null }
  const startWatch = (record) => {
    if (record.stopWatch || disposed || !isWatchActive() || !expanded.has(record.path)) return
    record.stopWatch = watchRegistry.subscribe(getProviderId(), record.path, () => refreshRecord(record))
  }
  const release = (record) => {
    stopWatch(record)
    record.listing.dispose()
    record.scope.stop()
    records.delete(record.key)
    const index = collapsedOrder.indexOf(record.key)
    if (index >= 0) collapsedOrder.splice(index, 1)
  }

  const createRecord = (entry, depth) => {
    const path = entry.path
    const key = keyOf(path)
    const state = reactive({ loaded: false, loading: false, children: [], error: null, sourceEntryCount: 0 })
    const record = { key, path, depth, state, stopWatch: null, scope: effectScope(true) }
    record.displayed = record.scope.run(() => computed(() => transformChildren(state.children, depth) || state.children))
    record.listing = createDirectoryListing({
      state,
      consumer,
      getLocation: () => ({ providerId: getProviderId(), path }),
      isActive: () => !disposed && expanded.has(path) && records.get(key) === record,
      list: (target, options) => listDirectory(target, options),
      onLoaded: (payload) => { onChildrenLoaded(payload); syncExpanded() },
      cloudStatus,
      statusOrder: () => statusPriority(path, record),
    })
    records.set(key, record)
    return record
  }

  const loadRecord = async (record, options = {}) => {
    const loaded = await record.listing.load(options)
    // A cached folder resolves without onLoaded; still restore its children.
    if (loaded) syncExpanded()
    return loaded
  }
  const refreshRecord = (record) => {
    if (disposed || !expanded.has(record.path) || records.get(record.key) !== record) return Promise.resolve(false)
    return loadRecord(record, { force: true })
  }

  const expand = (entry, depth = 0, { silent = false } = {}) => {
    if (disposed || !entry?.isDirectory) return
    const already = expanded.has(entry.path)
    expanded.add(entry.path)
    let record = recordOf(entry.path)
    if (record) {
      const index = collapsedOrder.indexOf(record.key)
      if (index >= 0) collapsedOrder.splice(index, 1)
    } else record = createRecord(entry, depth)
    if (!already && !silent) onExpandedChange({ path: entry.path, expanded: true })
    startWatch(record)
    // This PC is a small live inventory, always read again on open.
    void loadRecord(record, { force: isComputerPath(entry.path) })
  }

  const collapse = (path) => {
    if (!expanded.has(path)) return
    expanded.delete(path)
    const record = recordOf(path)
    if (record) {
      record.listing.invalidate()
      stopWatch(record)
      collapsedOrder.push(record.key)
    }
    // Descendants are released, as their rows were before; the parent view
    // (expandedPaths) decides whether they reopen with this folder.
    for (const other of [...records.values()]) {
      if (other.path !== path && isSameOrDescendantPath(path, other.path)) {
        expanded.delete(other.path)
        release(other)
      }
    }
    for (const value of [...expanded]) {
      if (value !== path && isSameOrDescendantPath(path, value)) expanded.delete(value)
    }
    while (collapsedOrder.length > COLLAPSED_DIRECTORY_LIMIT) {
      const oldest = records.get(collapsedOrder[0])
      if (oldest) release(oldest)
      else collapsedOrder.shift()
    }
    onExpandedChange({ path, expanded: false })
  }

  const toggle = (entry, depth) => (expanded.has(entry.path) ? collapse(entry.path) : expand(entry, depth))

  // Open the folders listed by the owner (panel restore, reveal in sidebar)
  // once their parent is shown. Only ever expands; collapsing is explicit.
  const syncExpanded = () => {
    if (disposed) return
    const wanted = new Set(getExpandedPaths() || [])
    if (!wanted.size) return
    for (const record of [...records.values()]) {
      if (!expanded.has(record.path) || !record.state.loaded) continue
      for (const child of record.displayed.value) {
        if (child.isDirectory && wanted.has(child.path) && !expanded.has(child.path)) expand(child, record.depth + 1)
      }
    }
  }

  const directoryOf = (path) => {
    const record = recordOf(path)
    return record ? { state: record.state, displayed: record.displayed.value } : null
  }
  const flat = scope.run(() => computed(() => flattenTree({
    root: getRoot(),
    isExpanded: (path) => expanded.has(path),
    directoryOf,
    renameError: rename.path && rename.error ? { path: rename.path, message: rename.error } : null,
  })))

  const refreshExpanded = () => {
    for (const record of [...records.values()]) void refreshRecord(record)
  }
  const refreshDirectory = (path) => {
    const record = recordOf(path)
    return record ? refreshRecord(record) : Promise.resolve(false)
  }
  const setWatchActive = (active) => {
    for (const record of records.values()) {
      if (active) { startWatch(record); void refreshRecord(record) } else { record.listing.invalidate(); stopWatch(record) }
    }
  }

  // The root opens by default without becoming an expanded path. Re-rooting (the editor sidebar browsing to another
  // folder) releases the old tree first.
  const resetRoot = () => {
    for (const record of [...records.values()]) release(record)
    expanded.clear()
    collapsedOrder.length = 0
    cancelRename(true)
    const root = getRoot()
    if (root?.isDirectory) expand(root, 0, { silent: true })
  }

  const beginRename = (entry) => {
    Object.assign(rename, { path: entry.path, draft: entry.name, error: '', busy: false, selectionStart: null, selectionEnd: null })
  }
  function cancelRename (force = false) {
    if (rename.busy && !force) return
    Object.assign(rename, { path: '', draft: '', error: '', busy: false, selectionStart: null, selectionEnd: null })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const record of [...records.values()]) release(record)
    expanded.clear()
    scope.stop()
  }

  const rows = scope.run(() => computed(() => flat.value.rows))
  return {
    rows,
    indexOf: (path) => flat.value.indexByPath.get(path) ?? -1,
    flat,
    expanded,
    rename,
    drag,
    isExpanded: (path) => expanded.has(path),
    recordOf,
    childrenOf: (path) => recordOf(path)?.state.children || [],
    displayedOf: (path) => recordOf(path)?.displayed.value || [],
    loadingOf: (path) => Boolean(recordOf(path)?.state.loading),
    statusOf: (path, parentPath) => recordOf(parentPath)?.listing.statusOf(path),
    expand,
    collapse,
    toggle,
    syncExpanded,
    refreshExpanded,
    refreshDirectory,
    setWatchActive,
    resetRoot,
    beginRename,
    cancelRename,
    dispose,
    recordCount: () => records.size,
  }
}
