import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { entryNameError } from '../shared/entryName.js'
import {
  fileManagerRoot,
  resolveInsideRoot,
  verifyRealPathInsideRoot,
} from './filesystem.js'

const supportedActions = new Set(['copy', 'move', 'link', 'delete', 'create-file', 'create-folder', 'rename'])

const createOperationError = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}

const WINDOWS_SYMLINK_PRIVILEGE_MESSAGE =
  'Windows could not create the symbolic link. Enable Developer Mode or grant this account the Create symbolic links privilege, then try again.'

export const normalizeSymlinkError = (
  error,
  platform = process.platform,
) => {
  if (
    platform === 'win32' &&
    ['EPERM', 'EACCES'].includes(error?.code)
  ) {
    const normalized = createOperationError(
      'ESYMLINK_PRIVILEGE',
      WINDOWS_SYMLINK_PRIVILEGE_MESSAGE,
    )
    normalized.cause = error
    return normalized
  }

  return error
}

const createSymbolicLink = async (target, destination, type) => {
  try {
    await fs.symlink(target, destination, type)
  } catch (error) {
    throw normalizeSymlinkError(error)
  }
}

const isSameOrInside = (parentPath, targetPath) => {
  const relativePath = path.relative(parentPath, targetPath)

  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  )
}

const ensureDestinationAvailable = async (destinationPath) => {
  try {
    await fs.lstat(destinationPath)
    throw createOperationError(
      'EEXIST',
      'An item with this name already exists in the destination folder',
    )
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}

const copyEntry = async (sourcePath, destinationPath, sourceStats) => {
  try {
    if (sourceStats.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath)
      await createSymbolicLink(linkTarget, destinationPath)
      return
    }

    await fs.cp(sourcePath, destinationPath, {
      recursive: sourceStats.isDirectory(),
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
  } catch (error) {
    await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

const moveEntry = async (sourcePath, destinationPath, sourceStats) => {
  try {
    await fs.rename(sourcePath, destinationPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error
    }

    await copyEntry(sourcePath, destinationPath, sourceStats)

    try {
      await fs.rm(sourcePath, { recursive: sourceStats.isDirectory() })
    } catch (removeError) {
      await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => {})
      throw removeError
    }
  }
}

export const performFileOperation = async ({
  action,
  sourcePath,
  targetDirectory,
  name,
  filesystemId = 'local',
  targetFilesystemId,
}) => {
  if (filesystemId !== 'local' || (targetFilesystemId && targetFilesystemId !== 'local')) {
    throw createOperationError('EFILESYSTEM_ID', 'This filesystem is not available')
  }
  if (!supportedActions.has(action)) {
    throw createOperationError('EINVAL', 'Unknown file operation')
  }

  if (['create-file', 'create-folder', 'rename'].includes(action)) {
    const message = entryNameError(name)
    if (message) throw createOperationError('EINVALID_NAME', message)
  }

  if (action === 'create-file' || action === 'create-folder') {
    const parent = resolveInsideRoot(targetDirectory)
    await verifyRealPathInsideRoot(parent)
    const destinationPath = resolveInsideRoot(path.join(parent, name))
    if (action === 'create-folder') {
      await fs.mkdir(destinationPath)
    } else {
      const handle = await fs.open(destinationPath, 'wx')
      await handle.close()
    }
    return { action, sourcePath: null, targetDirectory: parent, destinationPath }
  }

  const resolvedSource = resolveInsideRoot(sourcePath)

  if (resolvedSource === fileManagerRoot) {
    throw createOperationError(
      'EROOT_OPERATION',
      'The configured filesystem root cannot be changed',
    )
  }

  const sourceStats = await fs.lstat(resolvedSource)

  if (action === 'rename') {
    const parent = path.dirname(resolvedSource)
    await verifyRealPathInsideRoot(parent)
    const destinationPath = resolveInsideRoot(path.join(parent, name))
    if (destinationPath !== resolvedSource) {
      await ensureDestinationAvailable(destinationPath)
      await fs.rename(resolvedSource, destinationPath)
    }
    return { action, sourcePath: resolvedSource, targetDirectory: parent, destinationPath }
  }

  if (action === 'delete') {
    await verifyRealPathInsideRoot(path.dirname(resolvedSource))
    await fs.rm(resolvedSource, {
      recursive: sourceStats.isDirectory(),
      force: false,
    })

    return {
      action,
      sourcePath: resolvedSource,
      targetDirectory: null,
      destinationPath: null,
    }
  }

  const resolvedTargetDirectory = resolveInsideRoot(targetDirectory)

  const [realSource, realTargetDirectory] = await Promise.all([
    verifyRealPathInsideRoot(resolvedSource),
    verifyRealPathInsideRoot(resolvedTargetDirectory),
  ])
  const targetStats = await fs.stat(resolvedTargetDirectory)

  if (!targetStats.isDirectory()) {
    throw createOperationError('ENOTDIR', 'The drop target is not a folder')
  }

  if (
    sourceStats.isDirectory() &&
    isSameOrInside(realSource, realTargetDirectory)
  ) {
    throw createOperationError(
      'ECYCLE',
      'A folder cannot be copied or moved into itself',
    )
  }

  const destinationPath = resolveInsideRoot(
    path.join(resolvedTargetDirectory, path.basename(resolvedSource)),
  )

  if (destinationPath === resolvedSource) {
    throw createOperationError(
      'ESAMEPATH',
      'The item is already in this folder',
    )
  }

  await ensureDestinationAvailable(destinationPath)

  if (action === 'copy') {
    await copyEntry(resolvedSource, destinationPath, sourceStats)
  } else if (action === 'move') {
    await moveEntry(resolvedSource, destinationPath, sourceStats)
  } else {
    const relativeSource = path.relative(resolvedTargetDirectory, resolvedSource)
    await createSymbolicLink(
      relativeSource,
      destinationPath,
      sourceStats.isDirectory() ? 'dir' : 'file',
    )
  }

  return {
    action,
    sourcePath: resolvedSource,
    targetDirectory: resolvedTargetDirectory,
    destinationPath,
  }
}

const operationErrorMessages = {
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOENT: 'The source or destination no longer exists',
  ENOTDIR: 'The drop target is not a folder',
  EEXIST: 'An item with this name already exists in the destination folder',
  EOUTSIDE_ROOT: 'Path is outside the configured root',
  EROOT_OPERATION: 'The configured filesystem root cannot be changed',
  ECYCLE: 'A folder cannot be copied or moved into itself',
  ESAMEPATH: 'The item is already in this folder',
  ESYMLINK_PRIVILEGE: WINDOWS_SYMLINK_PRIVILEGE_MESSAGE,
  EINVAL: 'Invalid file operation',
}

export const serializeOperationError = (error) => ({
  code: error?.code || 'EFILE_OPERATION',
  message:
    operationErrorMessages[error?.code] ||
    error?.message ||
    'The file operation failed',
})

export const registerFileOperationHandlers = (socket) => {
  socket.on('filesystem:operate', async (payload, acknowledge) => {
    try {
      const result = await performFileOperation(payload || {})
      acknowledge?.({ ok: true, result })
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeOperationError(error) })
    }
  })
}
