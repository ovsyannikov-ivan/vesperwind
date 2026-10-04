import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { normalizeMediaSource } from '../player/mediaSource.js'
import { content } from './content.js'

const getUrl = (location) => location?.sourceType === 'url' ? normalizeMediaSource(location).url : backend.getMediaUrl(location)
const prepare = async (location, options) => {
  if (location?.sourceType === 'url') return { ok: true, source: normalizeMediaSource(location).url }
  const response = normalizeApiResponse(
    await content.prepare(location, options),
    'EMEDIA_PREPARE',
    'Unable to prepare this file',
  )
  if (!response.ok) return response
  const source = normalizeApiResponse(
    await backend.getPreparedMediaSource(location),
    'EMEDIA_SOURCE',
    'Unable to create a media source',
  )
  return source.ok ? { ...response, source: source.source } : source
}

const getMetadata = async (location, { signal } = {}) => {
  if (signal?.aborted) return { ok: false, cancelled: true }
  const probeId = globalThis.crypto?.randomUUID?.() || `probe-${Date.now()}-${Math.random()}`
  const cancel = () => { void backend.request('media:cancel-metadata', { probeId }) }
  signal?.addEventListener('abort', cancel, { once: true })
  try { return await backend.request('media:metadata', { ...normalizeMediaSource(location), probeId }, { timeout: 15000 }) }
  finally { signal?.removeEventListener('abort', cancel) }
}
const probeSource = (location, { signal } = {}) => {
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true })
  if (backendRuntimeMode === 'tauri' || location.sourceType !== 'url') return getMetadata(location, { signal })
  return new Promise((resolve) => {
    const element = document.createElement('video')
    let timer, finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer); signal?.removeEventListener('abort', finish)
      element.removeEventListener('loadedmetadata', finish); element.removeEventListener('error', finish)
      const ok = element.readyState >= 1 && !signal?.aborted
      const result = { ok, kind: ok ? (element.videoWidth > 0 ? 'video' : 'audio') : null,
        duration: Number.isFinite(element.duration) ? element.duration : null, live: element.duration === Infinity, tags: {}, chapters: [] }
      element.removeAttribute('src'); element.load(); resolve(result)
    }
    element.autoplay = false; element.preload = 'metadata'
    element.addEventListener('loadedmetadata', finish, { once: true }); element.addEventListener('error', finish, { once: true })
    signal?.addEventListener('abort', finish, { once: true }); timer = setTimeout(finish, 10000)
    element.src = normalizeMediaSource(location).url; element.load()
  })
}

const getChapters = (location) => backend.request('media:chapters', location)

export const media = Object.freeze({ getUrl, prepare, getChapters, getMetadata, probeSource })
