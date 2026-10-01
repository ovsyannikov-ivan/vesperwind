import { COMPUTER_PATH, isComputerPath } from '../../shared/localFilesystem.js'

const windowsDrivePattern = /^[A-Za-z]:[\\/]/
const windowsSharePattern = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/

const pathFlavor = (value) =>
  windowsDrivePattern.test(value) || windowsSharePattern.test(value) ? 'windows' : 'posix'

const separatorFor = (flavor) => (flavor === 'windows' ? '\\' : '/')

const normalizeSeparators = (value, flavor) =>
  flavor === 'windows' ? value.replaceAll('/', '\\') : value

const rootLength = (value, flavor) => {
  if (flavor === 'windows') {
    return windowsDrivePattern.test(value) ? 3 : (value.match(/^\\\\[^\\]+\\[^\\]+/)?.[0].length || 0)
  }

  return value.startsWith('/') ? 1 : 0
}

export const normalizeFilesystemPath = (value, flavor = pathFlavor(value || '')) => {
  if (typeof value !== 'string' || value.length === 0) {
    return ''
  }

  if (isComputerPath(value)) return COMPUTER_PATH

  const normalized = normalizeSeparators(value, flavor)
  const minimumLength = rootLength(normalized, flavor)
  let end = normalized.length

  while (end > minimumLength && normalized[end - 1] === separatorFor(flavor)) {
    end -= 1
  }

  return normalized.slice(0, end)
}

const comparablePath = (value, flavor) =>
  flavor === 'windows' ? value.toLocaleLowerCase('en-US') : value

export const isSameOrDescendantPath = (parentPath, targetPath) => {
  if (typeof parentPath !== 'string' || typeof targetPath !== 'string') {
    return false
  }

  if (isComputerPath(parentPath)) return isComputerPath(targetPath) || pathFlavor(targetPath) === 'windows'

  const flavor = pathFlavor(parentPath)
  if (pathFlavor(targetPath) !== flavor) {
    return false
  }

  const parent = normalizeFilesystemPath(parentPath, flavor)
  const target = normalizeFilesystemPath(targetPath, flavor)
  const separator = separatorFor(flavor)
  const comparableParent = comparablePath(parent, flavor)
  const comparableTarget = comparablePath(target, flavor)

  return (
    comparableTarget === comparableParent ||
    comparableTarget.startsWith(
      comparableParent.endsWith(separator)
        ? comparableParent
        : `${comparableParent}${separator}`,
    )
  )
}

export const getFilesystemPathName = (value) => {
  if (isComputerPath(value)) return 'This Computer'
  if (typeof value !== 'string' || value.length === 0) {
    return ''
  }

  const flavor = pathFlavor(value)
  const normalized = normalizeFilesystemPath(value, flavor)
  const separator = separatorFor(flavor)
  const index = normalized.lastIndexOf(separator)

  return normalized.length === rootLength(normalized, flavor) || index < 0
    ? normalized
    : normalized.slice(index + 1)
}

export const buildFilesystemPathLevels = (rootPath, targetPath) => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    return []
  }

  if (isComputerPath(rootPath)) {
    if (!targetPath || isComputerPath(targetPath) || pathFlavor(targetPath) !== 'windows') return [COMPUTER_PATH]
    const target = normalizeFilesystemPath(targetPath)
    const volume = target.slice(0, rootLength(target, 'windows'))
    return [COMPUTER_PATH, ...buildFilesystemPathLevels(volume, target)]
  }

  const flavor = pathFlavor(rootPath)
  if (pathFlavor(targetPath || rootPath) !== flavor) {
    return [normalizeFilesystemPath(rootPath, flavor)]
  }

  const root = normalizeFilesystemPath(rootPath, flavor)
  const target = normalizeFilesystemPath(targetPath || root, flavor)
  if (!isSameOrDescendantPath(root, target) || target === root) {
    return [root]
  }

  const separator = separatorFor(flavor)
  const relativeStart = root.endsWith(separator) ? root.length : root.length + 1
  const segments = target.slice(relativeStart).split(separator).filter(Boolean)
  const levels = [root]
  let current = root

  for (const segment of segments) {
    current = current.endsWith(separator)
      ? `${current}${segment}`
      : `${current}${separator}${segment}`
    levels.push(current)
  }

  return levels
}

export const getFilesystemParentPath = (value) => {
  if (isComputerPath(value)) return COMPUTER_PATH
  const flavor = pathFlavor(value || '')
  const normalized = normalizeFilesystemPath(value, flavor)
  const separator = separatorFor(flavor)
  const index = normalized.lastIndexOf(separator)
  const minimum = rootLength(normalized, flavor)
  return index < minimum ? normalized.slice(0, minimum) || normalized : normalized.slice(0, index)
}
