import { getFileExtension } from '../../shared/mediaTypes.js'

// Chapters alone are not an audiobook marker: music albums may have them too.
export const isAudiobook = (source) => {
  if (!source || source.sourceType === 'url' || source.live) return false
  if (getFileExtension(source.path || source.name) === 'm4b') return true
  const genre = Object.entries(source.tags || {}).find(([key]) => key.toLowerCase() === 'genre')?.[1]
  return typeof genre === 'string' && genre.split(/[;,/]/).some((part) =>
    ['audiobook', 'audio book', 'аудиокнига', 'аудиокниги'].includes(part.trim().toLowerCase()))
}

export const mediaHistoryEnabled = (source, { kind = source?.kind, temporary = false } = {}) =>
  Boolean(source) && !temporary && source?.sourceType !== 'url' && !source?.live &&
  (kind === 'video' || (kind === 'audio' && isAudiobook(source)))
