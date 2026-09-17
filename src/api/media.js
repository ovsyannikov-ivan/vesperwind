import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { content } from './content.js'

const getUrl = (location) => backend.getMediaUrl(location)
const prepare = async (location, options) => {
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

export const media = Object.freeze({ getUrl, prepare })
