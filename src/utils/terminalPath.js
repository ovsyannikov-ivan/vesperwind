export const TERMINAL_PATH_MIME = 'application/x-vesperwind-shell-path'

const safeShellPathPattern = /^[A-Za-z0-9_@%+=:,./~-]+$/

const quoteShellValue = (value) => `'${value.replaceAll("'", "'\\''")}'`

const shortenHomePath = (absolutePath, homePath) => {
  if (!homePath) {
    return absolutePath
  }

  const normalizedHome = homePath.endsWith('/')
    ? homePath.slice(0, -1)
    : homePath

  if (absolutePath === normalizedHome) {
    return '~'
  }

  if (absolutePath.startsWith(`${normalizedHome}/`)) {
    return `~${absolutePath.slice(normalizedHome.length)}`
  }

  return absolutePath
}

const quoteShellPath = (displayPath) => {
  if (safeShellPathPattern.test(displayPath)) {
    return displayPath
  }

  if (displayPath.startsWith('~/')) {
    return `~/${quoteShellValue(displayPath.slice(2))}`
  }

  return quoteShellValue(displayPath)
}

export const formatTerminalPath = (absolutePath, { homePath, directory } = {}) => {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return ''
  }

  let displayPath = shortenHomePath(absolutePath, homePath)

  if (directory && !displayPath.endsWith('/')) {
    displayPath += '/'
  }

  return quoteShellPath(displayPath)
}
