import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { createThumbnailService } from './thumbnailService.js'

export const video = createThumbnailService({
  generate: async (args) => backendRuntimeMode === 'tauri'
    ? normalizeApiResponse(await backend.request('video:thumbnail', args), 'ETHUMBNAIL', 'Thumbnail unavailable')
    : { ok: true, thumbnail: { status: 'unavailable', reason: 'runtime' } },
  cancel: async (requestId) => {
    if (backendRuntimeMode === 'tauri') await backend.request('video:thumbnail', {
      path: '', time: 0, width: 180, requestId, cancel: true,
    })
  },
})
