const extensionFromName = (name) => {
  if (typeof name !== 'string') {
    return ''
  }

  const normalizedName = name.trim().toLowerCase()
  const separatorIndex = normalizedName.lastIndexOf('.')

  return separatorIndex > -1 ? normalizedName.slice(separatorIndex + 1) : ''
}

export const videoExtensions = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'mpeg',
  'mpg',
])

export const audioExtensions = new Set([
  'mp3',
  'm4a',
  'aac',
  'wav',
  'wave',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aif',
  'aiff',
  'caf',
  'wma',
])

export const imageExtensions = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'tif',
  'tiff',
])

const previewableVideoExtensions = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const previewableAudioExtensions = new Set([
  'mp3',
  'm4a',
  'aac',
  'wav',
  'wave',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aif',
  'aiff',
  'caf',
])
const previewableImageExtensions = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
])

const contentTypes = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

export const getFileExtension = (name) => extensionFromName(name)

export const getMediaKind = (name) => {
  const extension = extensionFromName(name)

  if (videoExtensions.has(extension)) {
    return 'video'
  }

  if (audioExtensions.has(extension)) {
    return 'audio'
  }

  if (imageExtensions.has(extension)) {
    return 'image'
  }

  return null
}

export const canPreviewMedia = (name) => {
  const extension = extensionFromName(name)

  return (
    previewableVideoExtensions.has(extension) ||
    previewableAudioExtensions.has(extension) ||
    previewableImageExtensions.has(extension)
  )
}

export const getMediaContentType = (name) =>
  contentTypes[extensionFromName(name)] || 'application/octet-stream'
