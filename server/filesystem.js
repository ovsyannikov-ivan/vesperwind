import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const configuredRoot = process.env.FILE_MANAGER_ROOT?.trim()
const metadataConcurrency = 32

export const fileManagerRoot = path.resolve(configuredRoot || os.homedir())
export const homeDirectory = path.resolve(os.homedir())

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

export const resolveInsideRoot = (requestedPath) => {
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

export const verifyRealPathInsideRoot = async (resolvedPath) => {
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

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}

const readEntryMetadata = async (entryPath, isDirectory) => {
  try {
    const stats = await fs.lstat(entryPath)

    return {
      size: isDirectory ? null : stats.size,
      modifiedAt: stats.mtime.toISOString(),
      metadataError: null,
    }
  } catch (error) {
    return {
      size: null,
      modifiedAt: null,
      metadataError: {
        code: error?.code || 'ESTAT',
      },
    }
  }
}

const toEntry = async (parentPath, entry) => {
  const entryPath = path.join(parentPath, entry.name)
  const isDirectory = entry.isDirectory()
  const metadata = await readEntryMetadata(entryPath, isDirectory)

  return {
    name: entry.name,
    path: entryPath,
    type: isDirectory ? 'directory' : 'file',
    isDirectory,
    isSymbolicLink: entry.isSymbolicLink(),
    ...metadata,
  }
}

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
    size: null,
    modifiedAt: stats.mtime.toISOString(),
    metadataError: null,
  }
}

export const listDirectory = async (requestedPath) => {
  const resolvedPath = resolveInsideRoot(requestedPath)
  await verifyRealPathInsideRoot(resolvedPath)

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true })

  const sortedEntries = entries.sort(compareEntries)

  return mapWithConcurrency(
    sortedEntries,
    metadataConcurrency,
    (entry) => toEntry(resolvedPath, entry),
  )
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
  message: errorMessages[error?.code] || error?.message || 'Unable to read this folder',
  path: typeof requestedPath === 'string' ? requestedPath : null,
})

export const registerFilesystemHandlers = (socket, { ssh } = {}) => {
  socket.on('filesystem:root', async (payload, acknowledge) => {
    try {
      if (payload?.filesystemId && payload.filesystemId !== 'local') {
        const connection = await ssh.ensure(payload.filesystemId)
        acknowledge?.({ ok: true, root: connection.rootEntry(), initial: connection.initialEntry(), homePath: connection.homePath })
        return
      }
      const root = await getRootEntry()
      acknowledge?.({ ok: true, root, homePath: homeDirectory })
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
      if (payload?.filesystemId && payload.filesystemId !== 'local') {
        const entries = await (await ssh.ensure(payload.filesystemId)).list(requestedPath)
        acknowledge?.({ ok: true, path: requestedPath, entries })
        return
      }
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
