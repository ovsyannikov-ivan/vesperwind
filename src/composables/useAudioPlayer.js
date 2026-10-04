import { computed, onScopeDispose, reactive, watch } from 'vue'
import { createAudioPlaylist, createAudioPlaylistState } from '../player/audioPlaylist.js'
import { media } from '../api/media.js'
import { backendRuntimeMode } from '../api/backend.js'
import { selectPlayerBackend } from '../player/mediaPlayerBackend.js'
import { createWebAudioMetadataProbe } from '../player/webAudioMetadata.js'
import { entryChange } from './useEntryChanges.js'

export const useAudioPlayer = ({ onStop = () => {} } = {}) => {
  const state = reactive(createAudioPlaylistState())
  const webMetadata = backendRuntimeMode === 'tauri' ? null : createWebAudioMetadataProbe({ prepare: media.prepare })
  const playlist = createAudioPlaylist({ state, onStop, concurrency: webMetadata ? 1 : 2,
    getMetadata: webMetadata ? webMetadata.probe : media.getMetadata })
  const current = computed(() => state.items.find((item) => item.id === state.currentId) || null)
  let preparationGeneration = 0
  let controller = null
  const prepare = async (item) => {
    const generation = ++preparationGeneration
    controller?.abort()
    controller = null
    if (!item || (item.url && item.preparedId === item.id)) return
    item.loading = true; item.error = null
    const request = new AbortController()
    controller = request
    try {
      const native = await selectPlayerBackend('audio')
      if (generation !== preparationGeneration) return
      const response = native === 'mpv' ? { ok: true, source: 'native-audio' } : await media.prepare(item, { signal: request.signal })
      if (generation !== preparationGeneration) return
      if (response.ok) { item.url = response.source; item.preparedId = item.id }
      else item.error = response.error
    } catch (error) {
      if (generation === preparationGeneration) item.error = { message: error.message || 'Unable to prepare audio' }
    } finally { if (generation === preparationGeneration && item) item.loading = false }
  }
  watch(() => current.value?.id, () => { void prepare(current.value) }, { flush: 'sync' })
  watch(entryChange, (change) => { if (change?.sourcePath) playlist.sync(change) })
  onScopeDispose(() => { playlist.dispose(); webMetadata?.dispose(); controller?.abort(); preparationGeneration++ })
  return { ...playlist, current, retry: () => { if (current.value) { current.value.url = ''; current.value.preparedId = null; void prepare(current.value) } },
    syncAfterFileOperation: (request, response) => {
      if (!response?.result || !request?.source) return
      playlist.sync({ action: request.action, providerId: request.source.providerId || request.source.filesystemId || 'local',
        sourcePath: request.source.path, destinationPath: response.result.destinationPath,
        destinationProviderId: request.target?.providerId || response.result.destinationProviderId || request.source.providerId || 'local' })
    },
  }
}
