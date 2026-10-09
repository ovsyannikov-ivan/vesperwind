import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { permissionsApi } from './permissions.js'

export const providerIdForConnection = (connectionId) => `sftp:${connectionId}`
export const connectionIdFromProvider = (providerId) =>
  typeof providerId === 'string' && providerId.startsWith('sftp:')
    ? providerId.slice(5)
    : null

const request = async (event, payload, fallback) =>
  normalizeApiResponse(await backend.request(event, payload, { timeout: 30_000 }), `E${event.toUpperCase().replaceAll(':', '_')}`, fallback)

export const connectionsApi = Object.freeze({
  connect: async (profile, secrets = '', options = {}) => {
    const access = await permissionsApi.prepareNetwork(profile.host, options)
    if (!access.ok) return access
    if (options.signal?.aborted) return { ok: false, error: { code: 'ECANCELLED', message: 'Connection was cancelled' } }
    return request('ssh:connect', typeof secrets === 'string' ? { profile, secret: secrets } : { profile, secrets }, 'Unable to connect to the remote host')
  },
  capabilities: () => request('connections:capabilities', {}, 'Unable to read connection capabilities'),
  sshConfigHosts: () => request('ssh:config-hosts', {}, 'Unable to read SSH configuration'),
  resolveSshHost: (alias) => request('ssh:config-resolve', { alias }, 'Unable to resolve SSH configuration'),
  credentialStatus: (profileId) => request('connections:credential-status', { profileId }, 'Unable to read saved credential status'),
  forgetCredential: (profileId, kind) => request('connections:forget-credential', { profileId, kind }, 'Unable to remove the saved credential'),
  disconnect: (connectionId) => request('ssh:disconnect', { connectionId }, 'Unable to disconnect'),
  status: (connectionId) => request('ssh:status', { connectionId }, 'Unable to read connection status'),
  onStatus: (callback) => backend.subscribe('ssh:status', callback),
})
