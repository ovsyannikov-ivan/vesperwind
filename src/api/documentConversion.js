import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

const encode = (bytes) => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export const convertImportedDocument = async (bytes, format) => {
  const response = normalizeApiResponse(await backend.request('document:convert', {
    base64: encode(bytes), format,
  }, { timeout: 90_000 }), 'EDOCUMENT_CONVERT', 'Unable to import this document')
  return response.ok ? { ...response, bytes: Uint8Array.from(atob(response.base64), (c) => c.charCodeAt(0)) } : response
}
