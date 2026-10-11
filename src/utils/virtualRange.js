// Fixed-height windowing for the file tree. Rows are logical; only the rows in
// [start, end) are mounted, with spacers standing in for the rest.
export const VIRTUAL_OVERSCAN = 12

const finite = (value) => (Number.isFinite(value) ? value : 0)

/**
 * `scrollTop` and `viewportHeight` describe the scroll container; `offset` is
 * where the first row starts inside its content and `inset` the height of a
 * sticky header covering the top of the viewport.
 */
export const computeVirtualRange = ({ count, rowHeight, scrollTop = 0, viewportHeight = 0, offset = 0,
  inset = 0, overscan = VIRTUAL_OVERSCAN }) => {
  if (!(count > 0) || !(rowHeight > 0)) return { start: 0, end: 0, first: 0, last: -1 }
  const top = Math.max(0, finite(scrollTop) + finite(inset) - finite(offset))
  const bottom = Math.max(top, finite(scrollTop) + Math.max(0, finite(viewportHeight)) - finite(offset))
  const first = Math.min(count - 1, Math.floor(top / rowHeight))
  const last = Math.min(count - 1, Math.max(first, Math.ceil(bottom / rowHeight) - 1))
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + 1 + overscan),
    first,
    last,
  }
}

/** The scrollTop that shows row `index` completely, or null when it already is. */
export const scrollTopForIndex = ({ index, rowHeight, scrollTop = 0, viewportHeight = 0, offset = 0, inset = 0,
  block = 'nearest' }) => {
  const rowTop = offset + index * rowHeight
  const rowBottom = rowTop + rowHeight
  const visibleTop = scrollTop + inset
  const visibleBottom = scrollTop + viewportHeight
  if (block === 'center') return Math.max(0, Math.round(rowTop - inset - (viewportHeight - inset - rowHeight) / 2))
  if (rowTop < visibleTop) return Math.max(0, rowTop - inset)
  if (rowBottom > visibleBottom) return Math.max(0, rowBottom - viewportHeight)
  return null
}
