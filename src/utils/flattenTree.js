// Flattens the expanded part of a file tree into the rows the virtual list
// shows, in display order. It reads only data that is already loaded: a closed
// folder contributes its own row, never a request for its contents.
//
// `directoryOf(path)` returns `{ state, displayed }` for a loaded folder, where
// `displayed` is that folder's children after the panel's sort and filter.
export const flattenTree = ({ root, isExpanded, directoryOf, renameError = null }) => {
  const rows = []
  const indexByPath = new Map()
  if (!root) return { rows, indexByPath }
  const visit = (entry, depth, parentPath, posInSet, setSize) => {
    const expanded = Boolean(entry.isDirectory && isExpanded(entry.path))
    indexByPath.set(entry.path, rows.length)
    rows.push({ key: entry.path, kind: 'entry', entry, depth, parentPath, expanded, posInSet, setSize })
    if (renameError?.path === entry.path && renameError.message) {
      rows.push({ key: `${entry.path}\0rename-error`, kind: 'rename-error', depth, parentPath, message: renameError.message })
    }
    if (!expanded) return
    const directory = directoryOf(entry.path)
    if (!directory) return
    const { state, displayed } = directory
    if (state.error) {
      rows.push({ key: `${entry.path}\0error`, kind: 'error', depth: depth + 1, parentPath: entry.path, message: state.error.message })
    } else if (state.loaded && displayed.length === 0) {
      rows.push({ key: `${entry.path}\0empty`, kind: 'empty', depth: depth + 1, parentPath: entry.path,
        message: state.sourceEntryCount > 0 ? 'No items match the current filters' : 'Empty folder' })
    }
    for (let index = 0; index < displayed.length; index++) {
      visit(displayed[index], depth + 1, entry.path, index + 1, displayed.length)
    }
  }
  visit(root, 0, null, 1, 1)
  return { rows, indexByPath }
}
