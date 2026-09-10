import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const configuredRoot = process.env.FILE_MANAGER_ROOT?.trim()

export const fileManagerRoot = path.resolve(configuredRoot || os.homedir())

const isInside = (rootPath, targetPath) => {
  const relativePath = path.relative(rootPath, targetPath)

  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  )
}

const createOutsideRootError = () => {
  const error = new Error('The requested path is outside FILE_MANAGER_ROOT')
  error.code = 'EOUTSIDE_ROOT'
  return error
}

const resolveInsideRoot = (requestedPath) => {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    const error = new TypeError('A directory path is required')
    error.code = 'EINVAL'
    throw error
  }

  const resolvedPath = path.resolve(requestedPath)

  if (!isInside(fileManagerRoot, resolvedPath)) {
    throw createOutsideRootError()
  }

  return resolvedPath
}

const verifyRealPathInsideRoot = async (resolvedPath) => {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(fileManagerRoot),
    fs.realpath(resolvedPath),
  ])

  if (!isInside(realRoot, realTarget)) {
    throw createOutsideRootError()
  }

  return realTarget
}

const compareEntries = (left, right) => {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1
  }

  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

const toEntry = (parentPath, entry) => ({
  name: entry.name,
  path: path.join(parentPath, entry.name),
  type: entry.isDirectory() ? 'directory' : 'file',
  isDirectory: entry.isDirectory(),
  isSymbolicLink: entry.isSymbolicLink(),
})

export const getRootEntry = async () => {
  const stats = await fs.stat(fileManagerRoot)

  if (!stats.isDirectory()) {
    const error = new Error('FILE_MANAGER_ROOT must point to a directory')
    error.code = 'ENOTDIR'
    throw error
  }

  const parsedRoot = path.parse(fileManagerRoot).root

  return {
    name: fileManagerRoot === parsedRoot ? parsedRoot : path.basename(fileManagerRoot),
    path: fileManagerRoot,
    type: 'directory',
    isDirectory: true,
    isSymbolicLink: false,
  }
}

export const listDirectory = async (requestedPath) => {
  const resolvedPath = resolveInsideRoot(requestedPath)
  await verifyRealPathInsideRoot(resolvedPath)

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true })

  return entries.sort(compareEntries).map((entry) => toEntry(resolvedPath, entry))
}

const errorMessages = {
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOENT: 'Folder no longer exists',
  ENOTDIR: 'This item is not a folder',
  EOUTSIDE_ROOT: 'Path is outside the configured root',
  EINVAL: 'Invalid path',
}

export const serializeFilesystemError = (error, requestedPath) => ({
  code: error?.code || 'EFILESYSTEM',
  message: errorMessages[error?.code] || 'Unable to read this folder',
  path: typeof requestedPath === 'string' ? requestedPath : null,
})

export const registerFilesystemHandlers = (socket) => {
  socket.on('filesystem:root', async (_payload, acknowledge) => {
    try {
      const root = await getRootEntry()
      acknowledge?.({ ok: true, root })
    } catch (error) {
      acknowledge?.({
        ok: false,
        error: serializeFilesystemError(error, fileManagerRoot),
      })
    }
  })

  socket.on('filesystem:list', async (payload, acknowledge) => {
    const requestedPath = payload?.path

    try {
      const entries = await listDirectory(requestedPath)
      acknowledge?.({ ok: true, path: requestedPath, entries })
    } catch (error) {
      acknowledge?.({
        ok: false,
        error: serializeFilesystemError(error, requestedPath),
      })
    }
  })
}
