import fs from 'node:fs/promises'
import path from 'node:path'
import {
  fileManagerRoot,
  resolveInsideRoot,
  verifyRealPathInsideRoot,
} from './filesystem.js'

const supportedActions = new Set(['copy', 'move', 'link', 'delete'])

const createOperationError = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
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
      await fs.symlink(linkTarget, destinationPath)
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
}) => {
  if (!supportedActions.has(action)) {
    throw createOperationError('EINVAL', 'Unknown file operation')
  }

  const resolvedSource = resolveInsideRoot(sourcePath)

  if (resolvedSource === fileManagerRoot) {
    throw createOperationError(
      'EROOT_OPERATION',
      'The configured filesystem root cannot be changed',
    )
  }

  const sourceStats = await fs.lstat(resolvedSource)

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
    await fs.symlink(
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
  EINVAL: 'Invalid file operation',
}

const serializeOperationError = (error) => ({
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
