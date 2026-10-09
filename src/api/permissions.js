import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'

const request = async (event, payload = {}, options) => normalizeApiResponse(
  await backend.request(event, payload, options), 'EPERMISSION', 'Unable to prepare access',
)
let capabilities
const getCapabilities = () => {
  if (backendRuntimeMode !== 'tauri') return Promise.resolve({ ok: true, supported: false })
  capabilities ||= request('permissions:capabilities').then(response => {
    if (!response.ok) capabilities = null
    return response
  })
  return capabilities
}
export const permissionsApi = Object.freeze({
  capabilities: getCapabilities,
  request: (kind, options = {}) => request('permissions:request', { kind, ...(options.host ? { host: options.host } : {}) }, { signal: options.signal }),
  prepareFolder: async (location, options = {}) => {
    if (location?.providerId && location.providerId !== 'local') return { ok: true }
    const supported = await getCapabilities()
    if (!supported.ok || !supported.supported) return supported
    return request('permissions:prepare-folder', { path: location?.path || '' }, { signal: options.signal })
  },
  prepareNetwork: async (host, options = {}) => {
    const supported = await getCapabilities()
    if (!supported.ok || !supported.supported) return supported
    options.onPermissionWait?.(true)
    try { return await request('permissions:request', { kind: 'network', host }, { signal: options.signal }) }
    finally { options.onPermissionWait?.(false) }
  },
})
