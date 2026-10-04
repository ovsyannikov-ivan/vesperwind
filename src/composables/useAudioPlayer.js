import { computed, onScopeDispose, reactive, watch } from 'vue'
import { createAudioPlaylist, createAudioPlaylistState } from '../player/audioPlaylist.js'
import { media } from '../api/media.js'
import { backendRuntimeMode } from '../api/backend.js'
import { selectPlayerBackend } from '../player/mediaPlayerBackend.js'
import { createWebAudioMetadataProbe } from '../player/webAudioMetadata.js'
import { PLAYLIST_STORAGE_KEY, playlistRecord, restorePlaylist } from '../player/playlistPersistence.js'
import { entryChange } from './useEntryChanges.js'

export const useAudioPlayer = ({ onStop = () => {}, storage = globalThis.localStorage, metadata, chooseBackend = selectPlayerBackend, prepareSource = media.prepare, random = Math.random } = {}) => {
  const state = reactive(createAudioPlaylistState())
  const webMetadata = metadata !== undefined || backendRuntimeMode === 'tauri' ? null : createWebAudioMetadataProbe({ prepare: media.prepare })
  const playlist = createAudioPlaylist({ state, random, onStop, concurrency: webMetadata ? 1 : 2,
    getMetadata: metadata !== undefined ? metadata : webMetadata ? webMetadata.probe : media.getMetadata })
  try { restorePlaylist(playlist, storage?.getItem(PLAYLIST_STORAGE_KEY)) } catch {}
  let persistenceTimer
  const persist = () => { try { storage?.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlistRecord(state))) } catch {} }
  watch(() => playlistRecord(state), () => { clearTimeout(persistenceTimer); persistenceTimer = setTimeout(persist, 200) }, { deep: true })
  globalThis.addEventListener?.('pagehide', persist)
  const current = computed(() => state.items.find((item) => item.id === state.currentId) || null)
  let preparationGeneration = 0
  let controller = null
  const prepare = async (item) => {
    const generation = ++preparationGeneration
    controller?.abort()
    controller = null
    if (!item || (item.preparedSource && item.preparedId === item.id)) return
    item.loading = true; item.error = null
    const request = new AbortController()
    controller = request
    try {
      const native = await chooseBackend('audio')
      if (generation !== preparationGeneration) return
      const response = native === 'mpv' ? { ok: true, source: 'native-audio' } : await prepareSource(item, { signal: request.signal })
      if (generation !== preparationGeneration) return
      if (response.ok) { item.preparedSource = response.source; item.preparedId = item.id }
      else item.error = response.error
    } catch (error) {
      if (generation === preparationGeneration) item.error = { message: error.message || 'Unable to prepare audio' }
    } finally { if (generation === preparationGeneration && item) item.loading = false }
  }
  watch(() => state.playRevision, () => { void prepare(current.value) }, { flush: 'sync' })
  watch(() => current.value?.id, () => { if (current.value?.preparedSource) void prepare(current.value) }, { flush: 'post' })
  watch(entryChange, (change) => { if (change?.sourcePath) playlist.sync(change) })
  onScopeDispose(() => { globalThis.removeEventListener?.('pagehide', persist); clearTimeout(persistenceTimer); persist(); playlist.dispose(); webMetadata?.dispose(); controller?.abort(); preparationGeneration++ })
  return { ...playlist, current, retry: () => { if (current.value) { current.value.preparedSource = ''; current.value.preparedId = null; void prepare(current.value) } },
    syncAfterFileOperation: (request, response) => {
      if (!response?.result || !request?.source) return
      playlist.sync({ action: request.action, providerId: request.source.providerId || request.source.filesystemId || 'local',
        sourcePath: request.source.path, destinationPath: response.result.destinationPath,
        destinationProviderId: request.target?.providerId || response.result.destinationProviderId || request.source.providerId || 'local' })
    },
  }
}
