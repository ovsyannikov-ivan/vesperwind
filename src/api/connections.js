import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

export const providerIdForConnection = (connectionId) => `sftp:${connectionId}`
export const connectionIdFromProvider = (providerId) =>
  typeof providerId === 'string' && providerId.startsWith('sftp:')
    ? providerId.slice(5)
    : null

const request = async (event, payload, fallback) =>
  normalizeApiResponse(await backend.request(event, payload, { timeout: 30_000 }), `E${event.toUpperCase().replaceAll(':', '_')}`, fallback)

export const connectionsApi = Object.freeze({
  connect: (profile, secret = '') => request('ssh:connect', { profile, secret }, 'Unable to connect to the remote host'),
  disconnect: (connectionId) => request('ssh:disconnect', { connectionId }, 'Unable to disconnect'),
  status: (connectionId) => request('ssh:status', { connectionId }, 'Unable to read connection status'),
  onStatus: (callback) => backend.subscribe('ssh:status', callback),
})
