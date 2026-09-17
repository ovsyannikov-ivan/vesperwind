import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'

export const FILE_ENTRY_MIME = 'application/x-vesperwind-file-entry'

export const createFileDragPayload = (
  node,
  panelSide,
  providerId = LOCAL_FILESYSTEM_PROVIDER,
) =>
  JSON.stringify({
    providerId,
    path: node.path,
    name: node.name,
    isDirectory: Boolean(node.isDirectory),
    panelSide,
  })

export const parseFileDragPayload = (value) => {
  try {
    const payload = JSON.parse(value)

    if (
      typeof payload?.path !== 'string' ||
      payload.path.length === 0 ||
      typeof payload?.providerId !== 'string' ||
      payload.providerId.length === 0 ||
      typeof payload?.name !== 'string' ||
      typeof payload?.isDirectory !== 'boolean' ||
      !['left', 'right'].includes(payload?.panelSide)
    ) {
      return null
    }

    return payload
  } catch {
    return null
  }
}
