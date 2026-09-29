import { isSameOrDescendantPath } from './filesystemPath.js'
import { sortAndFilterEntries } from './fileDirectoryView.js'

export const reconcileFilteredSelection = (selection, entries, view) => {
  const visible = new Set(sortAndFilterEntries(entries, view, 0).map((entry) => entry.path))
  const hiddenRoots = entries.filter((entry) => !visible.has(entry.path)).map((entry) => entry.path)
  const selectedEntries = selection.selectedEntries.filter((entry) =>
    !hiddenRoots.some((path) => isSameOrDescendantPath(path, entry.path)))
  const anchorPath = selectedEntries.some((entry) => entry.path === selection.anchorPath)
    ? selection.anchorPath : selectedEntries[0]?.path || ''
  return { selectedEntries, anchorPath }
}
