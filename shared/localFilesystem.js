// A navigation location, never a path passed to the operating system.
export const COMPUTER_PATH = 'computer://'
export const isComputerPath = (value) => value === COMPUTER_PATH
export const isWindowsVolumeRoot = (value) => typeof value === 'string' && (
  /^[A-Za-z]:[\\/]$/.test(value) || /^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(value)
)
export const isFilesystemRootEntry = (entry) => isComputerPath(entry?.path) ||
  entry?.path === '/' || isWindowsVolumeRoot(entry?.path)

export const localNavigation = ({ desktop, platform, home, browserRoot }) => {
  if (!desktop) return { root: browserRoot, initial: browserRoot }
  if (platform === 'win32') return { root: COMPUTER_PATH, initial: COMPUTER_PATH }
  return { root: '/', initial: platform === 'darwin' ? home : '/' }
}
