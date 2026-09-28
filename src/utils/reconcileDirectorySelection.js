import { buildFilesystemPathLevels } from './filesystemPath.js'

export const reconcileDirectorySelection = (selection, directoryPath, entries, providerId) => {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const selectedEntries = selection.selectedEntries.flatMap((entry) => {
    const levels = buildFilesystemPathLevels(directoryPath, entry.path)
    if (levels.length < 2 || levels[0] !== directoryPath) return [entry]
    const child = byPath.get(levels[1])
    if (!child) return []
    return levels.length === 2 ? [{ ...child, providerId }] : [entry]
  })
  const anchorPath = selectedEntries.some((entry) => entry.path === selection.anchorPath)
    ? selection.anchorPath : selectedEntries[0]?.path || ''
  const selectedNode = selection.selectedNode?.path === selection.rootPath
    ? selection.selectedNode
    : selectedEntries.find((entry) => entry.path === selection.selectedNode?.path) ||
      selectedEntries.at(-1) || selection.root
  return { selectedEntries, anchorPath, selectedNode, selectedPath: selectedNode?.path || '' }
}
