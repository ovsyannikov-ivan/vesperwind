import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { permissionsApi } from './permissions.js'

export { isSftpProfile } from '../../shared/defaultSettings.js'

// Backend events of each connectable protocol. SFTP goes through ssh:*, FTP
// and FTPS through ftp:*. A protocol missing here (a preserved or future
// profile) is never connected.
const BACKENDS = Object.freeze({
  sftp: Object.freeze({ connect: 'ssh:connect', cancelConnect: 'ssh:cancel-connect', disconnect: 'ssh:disconnect', status: 'ssh:status' }),
  ftp: Object.freeze({ connect: 'ftp:connect', cancelConnect: 'ftp:cancel-connect', disconnect: 'ftp:disconnect', status: 'ftp:status' }),
  ftps: Object.freeze({ connect: 'ftp:connect', cancelConnect: 'ftp:cancel-connect', disconnect: 'ftp:disconnect', status: 'ftp:status' }),
})
const PROVIDER = /^(sftp|ftp|ftps):([A-Za-z0-9._-]{1,80})$/

/** `sftp:`, `ftp:` or `ftps:` + id; the protocol comes from the profile, never from the port. */
export const providerIdForConnection = (connectionId, protocol = 'sftp') =>
  BACKENDS[protocol] ? `${protocol}:${connectionId}` : null
export const providerIdForProfile = (profile) => providerIdForConnection(profile?.id, profile?.protocol)
export const connectionIdFromProvider = (providerId) => PROVIDER.exec(String(providerId ?? ''))?.[2] ?? null
export const protocolFromProvider = (providerId) => PROVIDER.exec(String(providerId ?? ''))?.[1] ?? null
export const isConnectableProtocol = (protocol) => Object.hasOwn(BACKENDS, protocol)

const unsupported = () => ({ ok: false, error: { code: 'EPROTOCOL_UNSUPPORTED', message: 'This connection type is not supported by this version of Vesperwind' } })

/** The API over a transport (`request`, `subscribe`) and the network permission step. */
export const createConnectionsApi = ({ transport, prepareNetwork }) => {
  const request = async (event, payload, fallback, timeout = 30_000) =>
    normalizeApiResponse(await transport.request(event, payload, { timeout }), `E${event.toUpperCase().replaceAll(':', '_')}`, fallback)
  return Object.freeze({
    /**
     * SFTP sends the profile and typed secrets; FTP/FTPS send only the id of the
     * **saved** profile and an optional typed password, so endpoint, TLS mode,
     * certificate pin and plaintext acknowledgement always come from settings.
     */
    connect: async (profile, secrets = '', options = {}) => {
      const events = BACKENDS[profile?.protocol]
      if (!events) return unsupported()
      const access = await prepareNetwork(profile.host, options)
      if (!access.ok) return access
      if (options.signal?.aborted) return { ok: false, error: { code: 'ECANCELLED', message: 'Connection was cancelled' } }
      const attempt = options.attemptId ? { attemptId: options.attemptId } : {}
      if (profile.protocol === 'sftp') {
        return request(events.connect, { ...(typeof secrets === 'string' ? { profile, secret: secrets } : { profile, secrets }), ...attempt }, 'Unable to connect to the remote host')
      }
      const password = typeof secrets === 'string' ? secrets : secrets?.password || ''
      return request(events.connect, { profileId: profile.id, password, ...attempt }, 'Unable to connect to the FTP server', 60_000)
    },
    /**
     * Stops the connect sent with `attemptId` on the backend, or closes it if
     * it already connected. `ok: false` (a backend without cancellation, such
     * as the native app) leaves a late result to the caller.
     */
    cancelConnect: (protocol, attemptId) => BACKENDS[protocol] && attemptId
      ? request(BACKENDS[protocol].cancelConnect, { attemptId }, 'Unable to cancel the connection')
      : Promise.resolve(unsupported()),
    capabilities: () => request('connections:capabilities', {}, 'Unable to read connection capabilities'),
    sshConfigHosts: () => request('ssh:config-hosts', {}, 'Unable to read SSH configuration'),
    resolveSshHost: (alias) => request('ssh:config-resolve', { alias }, 'Unable to resolve SSH configuration'),
    credentialStatus: (profileId) => request('connections:credential-status', { profileId }, 'Unable to read saved credential status'),
    forgetCredential: (profileId, kind) => request('connections:forget-credential', { profileId, kind }, 'Unable to remove the saved credential'),
    disconnect: (connectionId, protocol = 'sftp') => BACKENDS[protocol]
      ? request(BACKENDS[protocol].disconnect, { connectionId }, 'Unable to disconnect') : Promise.resolve(unsupported()),
    status: (connectionId, protocol = 'sftp') => BACKENDS[protocol]
      ? request(BACKENDS[protocol].status, { connectionId }, 'Unable to read connection status') : Promise.resolve(unsupported()),
    /**
     * One stream of `{ protocol, connectionId, providerId, status }` for SSH and
     * FTP events. ssh:status carries no protocol or provider; it is SFTP.
     */
    onStatus: (callback) => {
      const unsubscribers = [
        transport.subscribe('ssh:status', (event) => callback({ ...event, protocol: 'sftp', providerId: providerIdForConnection(event?.connectionId, 'sftp') })),
        transport.subscribe('ftp:status', (event) => {
          const protocol = protocolFromProvider(event?.providerId)
          if (protocol === 'ftp' || protocol === 'ftps') callback({ ...event, protocol })
        }),
      ]
      return () => { for (const unsubscribe of unsubscribers) unsubscribe() }
    },
  })
}

export const connectionsApi = createConnectionsApi({ transport: backend, prepareNetwork: (host, options) => permissionsApi.prepareNetwork(host, options) })
