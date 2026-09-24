import { isSameOrDescendantPath } from './filesystemPath.js'

const sameEntry = (left, right) =>
  left.providerId === right.providerId && left.path === right.path

export const selectFileEntries = ({ entries, anchorPath, clicked, visibleEntries, shiftKey = false, additiveKey = false }) => {
  if (shiftKey) {
    const anchor = visibleEntries.findIndex((entry) => entry.path === anchorPath)
    const current = visibleEntries.findIndex((entry) => sameEntry(entry, clicked))
    if (anchor >= 0 && current >= 0) {
      const range = visibleEntries.slice(Math.min(anchor, current), Math.max(anchor, current) + 1)
      const retained = additiveKey ? entries.filter((entry) => !range.some((item) => sameEntry(item, entry))) : []
      return { entries: [...retained, ...range], anchorPath, active: clicked }
    }
  }

  if (additiveKey) {
    const existing = entries.findIndex((entry) => sameEntry(entry, clicked))
    const next = existing < 0
      ? [...entries, clicked]
      : entries.filter((_, index) => index !== existing)
    return { entries: next, anchorPath: clicked.path, active: next.at(-1) || null }
  }

  return { entries: [clicked], anchorPath: clicked.path, active: clicked }
}

// A selected directory already contains its selected descendants during a
// transfer. Avoid copying or moving those descendants again at the target root.
export const transferSources = (entries) => {
  const unique = entries.filter((entry, index) =>
    entries.findIndex((other) => sameEntry(other, entry)) === index)
  return unique.filter((entry) => !unique.some((parent) =>
    parent !== entry && parent.providerId === entry.providerId && parent.isDirectory &&
    isSameOrDescendantPath(parent.path, entry.path)))
}
