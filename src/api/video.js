import { traceMedia } from './mediaDiagnostics.js'
import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { createThumbnailService } from './thumbnailService.js'

export const video = createThumbnailService({
  generate: async (args) => {
    const started = performance.now()
    const response = backendRuntimeMode === 'tauri'
      ? normalizeApiResponse(await backend.request('video:thumbnail', args, { timeout: 40_000 }), 'ETHUMBNAIL', 'Thumbnail unavailable')
      : { ok: true, thumbnail: { status: 'unavailable', reason: 'runtime' } }
    traceMedia('thumbnail.native-response', { elapsedMs: performance.now() - started,
      status: response.thumbnail?.status, reason: response.thumbnail?.reason, error: response.error,
      urlPrefix: response.thumbnail?.url?.slice(0, 23), urlLength: response.thumbnail?.url?.length })
    return response
  },
  cancel: async (requestId) => {
    if (backendRuntimeMode === 'tauri') await backend.request('video:thumbnail', {
      path: '', time: 0, width: 180, requestId, cancel: true,
    })
  },
})
