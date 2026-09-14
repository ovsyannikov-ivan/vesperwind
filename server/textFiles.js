import fs from 'node:fs/promises'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024

const requireLocalFilesystem = (filesystemId) => {
  if (!filesystemId || filesystemId === 'local') {
    return
  }

  const error = new Error('This filesystem is not available')
  error.code = 'EFILESYSTEM_ID'
  throw error
}

const resolveTextFile = async (requestedPath) => {
  const resolvedPath = resolveInsideRoot(requestedPath)
  const realPath = await verifyRealPathInsideRoot(resolvedPath)
  const stats = await fs.stat(realPath)

  if (!stats.isFile()) {
    const error = new Error('The requested path is not a file')
    error.code = 'EISDIR'
    throw error
  }

  if (stats.size > MAX_TEXT_FILE_BYTES) {
    const error = new Error('The file is too large for the text editor')
    error.code = 'EFILE_TOO_LARGE'
    throw error
  }

  return { realPath, stats }
}

export const readTextFile = async (requestedPath, filesystemId = 'local') => {
  requireLocalFilesystem(filesystemId)
  const { realPath, stats } = await resolveTextFile(requestedPath)

  return {
    content: await fs.readFile(realPath, 'utf8'),
    modifiedAt: stats.mtime.toISOString(),
  }
}

export const writeTextFile = async (
  requestedPath,
  content,
  filesystemId = 'local',
) => {
  requireLocalFilesystem(filesystemId)

  if (typeof content !== 'string') {
    const error = new TypeError('Text content is required')
    error.code = 'EINVAL'
    throw error
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    const error = new Error('The file is too large for the text editor')
    error.code = 'EFILE_TOO_LARGE'
    throw error
  }

  const { realPath } = await resolveTextFile(requestedPath)
  await fs.writeFile(realPath, content, 'utf8')
  const stats = await fs.stat(realPath)

  return { modifiedAt: stats.mtime.toISOString() }
}

const messages = {
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOENT: 'File no longer exists',
  EISDIR: 'This item is not a text file',
  EOUTSIDE_ROOT: 'Path is outside the configured root',
  EFILE_TOO_LARGE: 'Files larger than 10 MB cannot be opened in the editor',
  EFILESYSTEM_ID: 'This filesystem is not available',
  EINVAL: 'Invalid file contents',
}

const serializeTextFileError = (error, requestedPath) => ({
  code: error?.code || 'ETEXTFILE',
  message: messages[error?.code] || 'Unable to read or save this file',
  path: typeof requestedPath === 'string' ? requestedPath : null,
})

export const registerTextFileHandlers = (socket) => {
  socket.on('filesystem:read-text', async (payload, acknowledge) => {
    try {
      acknowledge?.({
        ok: true,
        ...(await readTextFile(payload?.path, payload?.filesystemId)),
      })
    } catch (error) {
      acknowledge?.({
        ok: false,
        error: serializeTextFileError(error, payload?.path),
      })
    }
  })

  socket.on('filesystem:write-text', async (payload, acknowledge) => {
    try {
      acknowledge?.({
        ok: true,
        ...(await writeTextFile(
          payload?.path,
          payload?.content,
          payload?.filesystemId,
        )),
      })
    } catch (error) {
      acknowledge?.({
        ok: false,
        error: serializeTextFileError(error, payload?.path),
      })
    }
  })
}
