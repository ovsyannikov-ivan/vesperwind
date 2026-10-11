// Files of one folder ordered by distance from the middle of the virtual
// window: the visible rows first, then their neighbours. It walks outward over
// the flat rows and stops after `limit` files or `reach` rows, so choosing a
// cloud status batch never sorts a whole folder. Files further away are left
// to the scan's display order.
export const STATUS_PRIORITY_LIMIT = 256
export const STATUS_PRIORITY_REACH = 2048

export const viewportPriority = ({ rows, first, last, directoryPath, limit = STATUS_PRIORITY_LIMIT, reach = STATUS_PRIORITY_REACH }) => {
  const result = []
  if (!rows?.length) return result
  const center = Math.min(rows.length - 1, Math.max(0, Math.floor((first + Math.max(first, last)) / 2)))
  const accept = (row) => {
    if (row?.kind === 'entry' && row.parentPath === directoryPath && !row.entry.isDirectory) result.push(row.entry)
  }
  for (let offset = 0; offset <= reach && result.length < limit; offset++) {
    const below = center + offset
    const above = center - offset - 1
    if (below >= rows.length && above < 0) break
    if (below < rows.length) accept(rows[below])
    if (above >= 0 && result.length < limit) accept(rows[above])
  }
  return result
}
