import { normalizeMediaSource, mediaIdentity } from './mediaSource.js'
export const PLAYLIST_STORAGE_KEY = 'vesperwind:audio-playlist:v1'
export const playlistRecord = (state) => ({
  version: 1,
  items: state.items.map((item) => ({ ...normalizeMediaSource(item), name: item.name || '', displayName: item.displayName || '' })),
  currentId: state.currentId, selectedId: state.selectedId,
  repeat: state.repeat, shuffle: state.shuffle, visible: state.visible,
})
export const restorePlaylist = (playlist, value) => {
  try {
    const record = JSON.parse(value)
    if (record?.version !== 1 || !Array.isArray(record.items) || record.items.length > 10000) return false
    const sources = record.items.map((item) => ({ ...normalizeMediaSource(item), name: typeof item.name === 'string' ? item.name : '',
      displayName: typeof item.displayName === 'string' ? item.displayName : '', kind: 'audio' }))
    playlist.add(sources)
    const ids = new Set(sources.map(mediaIdentity))
    playlist.state.currentId = ids.has(record.currentId) ? record.currentId : null
    playlist.state.selectedId = ids.has(record.selectedId) ? record.selectedId : playlist.state.items[0]?.id || null
    playlist.state.repeat = ['off', 'all', 'one'].includes(record.repeat) ? record.repeat : 'off'
    playlist.setShuffle(record.shuffle === true)
    playlist.state.visible = record.visible === true
    playlist.state.autoplay = false
    return true
  } catch { return false }
}
