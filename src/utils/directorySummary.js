// Only listing metadata is used: never traverse folders or read file contents.
export const summarizeDirectory = (entries) => {
  let folders = 0
  let files = 0
  let bytes = 0
  let unknownSizes = 0
  for (const entry of entries) {
    if (entry.isDirectory) folders += 1
    else {
      files += 1
      if (Number.isFinite(entry.size) && entry.size >= 0) bytes += entry.size
      else unknownSizes += 1
    }
  }
  return { folders, files, bytes, unknownSizes }
}

const sizeFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export const formatDirectorySize = ({ bytes, files, unknownSizes }) => {
  if (files > 0 && unknownSizes === files) return '—'
  const unit = bytes < 1000 ? 0 : Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  return `${unknownSizes ? '≥ ' : ''}${sizeFormatter.format(bytes / 1000 ** unit)} ${units[unit]}`
}
