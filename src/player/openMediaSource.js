import { normalizeMediaSource } from './mediaSource.js'
export const createSourceOpener = ({ probe, open, beforePlayback }) => async (source, { metadata, signal } = {}) => {
  const location = normalizeMediaSource(source)
  const result = metadata || await probe(location, { signal })
  if (signal?.aborted) return false
  if (!result?.ok || !['audio', 'video'].includes(result.kind)) throw new Error('Unable to inspect this media source (unavailable, unsupported, or timed out)')
  if (result.kind === 'video') await beforePlayback('video')
  if (signal?.aborted) return false
  return open(location, result)
}
