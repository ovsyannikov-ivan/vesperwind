import { getMediaKind } from '../../shared/mediaTypes.js'
import { normalizeMediaSource, trackLabel } from './mediaSource.js'

export const isPlaylistFile = (name) => /\.m3u8?$/i.test(name || '')
export const isHlsManifest = (text) => /^\s*#EXT-X-/im.test(text)
const splitPath = (value) => {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value)
  const path = windows ? value.replaceAll('\\', '/') : value
  const root = path.match(windows ? /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/)/ : /^\//)?.[0] || ''
  return { root, parts: path.slice(root.length).split('/').filter(Boolean), separator: windows ? '\\' : '/' }
}
export const resolvePlaylistPath = (playlistPath, value) => {
  if (/^\/|^[A-Za-z]:[\\/]|^\\\\/.test(value)) return value
  const base = splitPath(playlistPath)
  base.parts.pop()
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') base.parts.pop()
    else base.parts.push(part)
  }
  return (base.root + base.parts.join('/')).replaceAll('/', base.separator)
}
export const relativePlaylistPath = (destination, target) => {
  const from = splitPath(destination), to = splitPath(target)
  if (from.root.toLowerCase() !== to.root.toLowerCase() || from.separator !== to.separator) return target
  from.parts.pop()
  let common = 0
  while (common < from.parts.length && common < to.parts.length && from.parts[common] === to.parts[common]) common++
  return [...from.parts.slice(common).map(() => '..'), ...to.parts.slice(common)].join('/') || target
}
export const playlistParentPath = (value) => {
  const path = splitPath(value)
  path.parts.pop()
  return (path.root + path.parts.join('/')).replaceAll('/', path.separator) || '/'
}
export const parseM3u = (text, location) => {
  if (typeof text !== 'string' || text.length > 3 * 1024 * 1024) throw new Error('Playlist is too large')
  if (isHlsManifest(text)) return { hls: true, entries: [], skipped: 0 }
  let info = {}, skipped = 0
  const entries = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^#EXTINF:/i.test(line)) {
      const match = /^#EXTINF:([^,]*),(.*)$/i.exec(line)
      info = match ? { duration: Number(match[1]) > 0 ? Number(match[1]) : null, displayName: match[2].trim() } : {}
      continue
    }
    if (line.startsWith('#')) continue
    try {
      if (/^https?:\/\//i.test(line)) {
        const source = normalizeMediaSource({ sourceType: 'url', url: line })
        if (/\.m3u$/i.test(new URL(source.url).pathname)) skipped++
        else entries.push({ ...source, ...info })
      }
      else if (/^[a-z][a-z0-9+.-]*:/i.test(line) && !/^[A-Za-z]:[\\/]/.test(line)) skipped++
      else {
        const path = resolvePlaylistPath(location.path, line)
        const name = path.split(/[\\/]/).pop()
        // Nested playlists are deliberately rejected; no recursive expansion.
        if (getMediaKind(name) !== 'audio' || isPlaylistFile(name)) skipped++
        else entries.push({ sourceType: 'provider', providerId: location.providerId || 'local', path, name, kind: 'audio', ...info })
      }
    } catch { skipped++ }
    info = {}
    if (entries.length > 10000) throw new Error('Playlist has too many entries')
  }
  return { hls: false, entries, skipped }
}
const safeLine = (value) => String(value || '').replace(/[\r\n\u0000]/g, ' ')
export const exportM3u = (items, destination) => {
  if (items.some((item) => item.sourceType !== 'url' && item.providerId !== destination.providerId)) {
    throw new Error('This playlist contains files from another provider. Export to the same provider or remove those entries first.')
  }
  return ['#EXTM3U', ...items.flatMap((item) => {
    let source = item.sourceType === 'url' ? normalizeMediaSource(item).url : relativePlaylistPath(destination.path, item.path)
    if (/[\r\n\u0000]/.test(source)) throw new Error('A playlist path cannot contain a newline')
    if (source.trim() !== source) throw new Error('A playlist path cannot start or end with whitespace')
    if (source.startsWith('#')) source = `./${source}`
    return [`#EXTINF:${Number.isFinite(item.duration) && item.duration > 0 ? Math.round(item.duration) : -1},${safeLine(trackLabel(item))}`, source]
  }), ''].join('\n')
}
