import { wildcardMatch } from '../../shared/wildcard.js'

export const extensionOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : ''
}

export const nameMatches = (name, query) => {
  const needle = String(query || '').trim()
  if (!needle) return true
  if (!/[?*]/.test(needle)) return name.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
  return wildcardMatch(name, needle)
}

export const sortAndFilterEntries = (entries, view = {}, depth = 0) => {
  const extensions = view.extensions || []
  const shown = entries.filter((entry) => depth !== 0 ||
    (nameMatches(entry.name, view.name) &&
      (entry.isDirectory
        ? view.keepFolders !== false || !extensions.length
        : !extensions.length || extensions.includes(extensionOf(entry.name)))))
  const direction = view.direction === 'desc' ? -1 : 1
  const criterion = view.sort || 'name'
  return [...shown].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    let value = 0
    if (criterion === 'size') value = (a.size ?? -1) - (b.size ?? -1)
    else if (criterion === 'date') value = (new Date(a.modifiedAt || 0).getTime() || 0) - (new Date(b.modifiedAt || 0).getTime() || 0)
    else value = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return direction * (value || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  })
}

export const availableExtensions = (entries) => [...new Set(entries.filter((entry) => !entry.isDirectory)
  .map((entry) => extensionOf(entry.name)))].sort((a, b) => a.localeCompare(b))
