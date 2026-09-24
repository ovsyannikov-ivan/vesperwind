import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'

export const FILE_ENTRY_MIME = 'application/x-vesperwind-file-entry'

export const createFileDragPayload = (
  node,
  panelSide,
  providerId = LOCAL_FILESYSTEM_PROVIDER,
  selectedEntries = [node],
) => {
  const sources = selectedEntries.map((entry) => ({
    providerId,
    path: entry.path,
    name: entry.name,
    isDirectory: Boolean(entry.isDirectory),
  }))
  return JSON.stringify({
    providerId,
    path: node.path,
    name: node.name,
    isDirectory: Boolean(node.isDirectory),
    panelSide,
    ...(sources.length > 1 ? { sources } : {}),
  })
}

const validSource = (source) =>
  typeof source?.providerId === 'string' && source.providerId.length > 0 &&
  typeof source?.path === 'string' && source.path.length > 0 &&
  typeof source?.name === 'string' &&
  typeof source?.isDirectory === 'boolean'

export const parseFileDragPayload = (value) => {
  try {
    const payload = JSON.parse(value)

    if (
      !validSource(payload) ||
      !['left', 'right'].includes(payload?.panelSide)
    ) {
      return null
    }

    if (payload.sources !== undefined && (
      !Array.isArray(payload.sources) || payload.sources.length < 2 ||
      payload.sources.length > 1000 ||
      !payload.sources.every((source) => validSource(source) && source.providerId === payload.providerId) ||
      !payload.sources.some((source) => source.path === payload.path)
    )) return null

    return payload
  } catch {
    return null
  }
}
