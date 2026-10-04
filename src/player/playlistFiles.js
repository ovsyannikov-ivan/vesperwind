import { parseM3u, resolvePlaylistPath, playlistParentPath } from './m3u.js'
import { normalizeMediaSource } from './mediaSource.js'

// Serial import workers bound URL probes and provider directory requests too.
export const importPlaylist = async (location, { filesystem, media, audio, openHls, signal } ) => {
  const response = await filesystem.readText(location, { maxBytes: 3 * 1024 * 1024, strictText: true, signal })
  if (!response?.ok) throw new Error(response?.error?.message || 'Unable to read playlist')
  const parsed = parseM3u(response.content, location)
  if (parsed.hls) {
    if (location.providerId !== 'local') throw new Error('HLS with sibling segments is supported only on the local provider')
    const metadata = await media.getMetadata(location, { signal })
    if (!metadata?.ok || !metadata.kind) throw new Error('Unable to inspect HLS media')
    await openHls(location, metadata)
    return { hls: true, imported: 0, skipped: 0 }
  }
  const accepted = new Array(parsed.entries.length)
  const directories = new Map()
  let cursor = 0, skipped = parsed.skipped
  const worker = async () => {
    while (cursor < parsed.entries.length && !signal?.aborted) {
      const index = cursor++, entry = parsed.entries[index]
      try {
        if (entry.sourceType === 'url') {
          const metadata = await (media.probeSource || media.getMetadata)(entry, { signal })
          if (!metadata?.ok || metadata.kind !== 'audio') { skipped++; continue }
          accepted[index] = { ...entry, kind: 'audio', duration: metadata.duration, tags: metadata.tags, chapters: metadata.chapters, live: metadata.live, metadataLoaded: true }
        } else {
          const directory = playlistParentPath(entry.path)
          if (!directories.has(directory)) directories.set(directory, filesystem.readDir({ providerId: entry.providerId, path: directory }))
          const listing = await directories.get(directory)
          if (!listing?.ok || !listing.entries?.some((item) => item.path === entry.path && !item.isDirectory)) { skipped++; continue }
          accepted[index] = entry
        }
      } catch { skipped++ }
    }
  }
  await Promise.all([worker(), worker()])
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  const ids = audio.add(accepted.filter(Boolean))
  audio.state.visible = true
  if (ids.length) audio.state.selectedId = ids[0]
  return { imported: ids.length, skipped, duplicates: accepted.filter(Boolean).length - ids.length }
}
export const playlistDestination = (directory, value) => {
  const name = String(value || '').trim()
  if (!/\.m3u8?$/i.test(name) || /[\r\n\u0000]/.test(name)) throw new Error('Use a .m3u or .m3u8 filename')
  return normalizeMediaSource({ sourceType: 'provider', providerId: directory.providerId,
    path: resolvePlaylistPath(`${directory.path.replace(/[\\/]$/, '')}/playlist.m3u8`, name) })
}
