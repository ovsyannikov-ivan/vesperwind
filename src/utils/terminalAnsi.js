const macOsDatalessBackground = '\x1b[1m\x1b[40m'
const themedDatalessBackground = '\x1b[22;39;100m'

export const normalizeTerminalAnsi = (value) =>
  value.replaceAll(macOsDatalessBackground, themedDatalessBackground)

const getPendingPrefixLength = (value) => {
  const maximumLength = Math.min(macOsDatalessBackground.length - 1, value.length)

  for (let length = maximumLength; length > 0; length -= 1) {
    if (macOsDatalessBackground.startsWith(value.slice(-length))) {
      return length
    }
  }

  return 0
}

export const createTerminalAnsiNormalizer = () => {
  let pending = ''

  return (value) => {
    const combined = pending + value
    const pendingLength = getPendingPrefixLength(combined)
    const ready = pendingLength ? combined.slice(0, -pendingLength) : combined
    pending = pendingLength ? combined.slice(-pendingLength) : ''

    return normalizeTerminalAnsi(ready)
  }
}
