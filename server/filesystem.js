import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isSea } from 'node:sea'
import { createFilesystemAccess, listWindowsDrives } from './filesystemAccess.js'
import { COMPUTER_PATH, isComputerPath, localNavigation } from '../shared/localFilesystem.js'

const configuredRoot = process.env.FILE_MANAGER_ROOT?.trim()
const metadataConcurrency = 32

export const desktopFilesystem = isSea()
export const fileManagerRoot = path.resolve(desktopFilesystem
  ? (process.platform === 'linux' ? '/' : os.homedir()) : configuredRoot || os.homedir())
export const homeDirectory = path.resolve(os.homedir())
const access = createFilesystemAccess({ root: fileManagerRoot, desktop: desktopFilesystem })
export const resolveInsideRoot = access.resolve
export const verifyRealPathInsideRoot = access.verify
const navigation = localNavigation({ desktop: desktopFilesystem, platform: process.platform,
  home: homeDirectory, browserRoot: fileManagerRoot })
export const isComputerRoot = (value) => desktopFilesystem && process.platform === 'win32' && isComputerPath(value)

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
  let isDirectory = entry.isDirectory()
  if (desktopFilesystem && entry.isSymbolicLink()) {
    try { isDirectory = (await fs.stat(entryPath)).isDirectory() } catch {}
  }
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

const directoryEntry = async (directory) => {
  if (directory === COMPUTER_PATH) return { name: 'This PC', path: COMPUTER_PATH,
    type: 'computer', isDirectory: true, isSymbolicLink: false, size: null,
    modifiedAt: null, metadataError: null }
  const stats = await fs.stat(directory)

  if (!stats.isDirectory()) {
    const error = new Error('FILE_MANAGER_ROOT must point to a directory')
    error.code = 'ENOTDIR'
    throw error
  }

  const parsedRoot = path.parse(directory).root

  return {
    name: directory === parsedRoot ? parsedRoot : path.basename(directory),
    path: directory,
    type: 'directory',
    isDirectory: true,
    isSymbolicLink: false,
    size: null,
    modifiedAt: stats.mtime.toISOString(),
    metadataError: null,
  }
}
export const getRootEntry = () => directoryEntry(navigation.root)
export const getInitialEntry = () => directoryEntry(navigation.initial)

export const listDirectory = async (requestedPath) => {
  if (isComputerRoot(requestedPath)) return listWindowsDrives()
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
      acknowledge?.({ ok: true, root, initial: await getInitialEntry(), homePath: homeDirectory })
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
