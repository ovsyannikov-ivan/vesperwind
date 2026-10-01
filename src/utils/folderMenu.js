import { sortAndFilterEntries } from './fileDirectoryView.js'

// Subfolders shown by a breadcrumb folder menu, in the panels' natural name order.
export const listSubfolders = (entries = []) =>
  sortAndFilterEntries(entries.filter((entry) => entry?.isDirectory), { sort: 'name' }, 1)

// The crumb after `index` is the child the user is currently inside.
export const currentChildPath = (breadcrumbs, index) => breadcrumbs[index + 1]?.path || ''

// Type-to-select: the next label after `fromIndex` that starts with `query`, wrapping around.
export const findTypeaheadIndex = (labels, query, fromIndex = -1) => {
  const needle = String(query || '').toLocaleLowerCase()
  if (!needle || !labels.length) return -1

  for (let offset = 1; offset <= labels.length; offset += 1) {
    const index = (fromIndex + offset + labels.length) % labels.length
    if (String(labels[index]).toLocaleLowerCase().startsWith(needle)) return index
  }

  return -1
}
