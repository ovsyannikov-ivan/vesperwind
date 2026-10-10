// Remote connection events of the Node/SEA runtime that are not SSH-specific:
// FTP/FTPS connect, disconnect and status, runtime capabilities and the
// (unavailable) credential store. Mirrors src-tauri/src/commands/ftp.rs.
import { FtpConnectionManager } from './ftp.js'

// Every protocol here connects in this runtime (test/ftpNodeAcceptance.test.js
// and test/sshConnections.test.js). There is no secure credential store and no
// SSH config discovery outside the native app.
export const NODE_CONNECTION_CAPABILITIES = Object.freeze({
  credentialStore: false, sshConfig: false, auto: true, agent: true,
  protocols: Object.freeze(['sftp', 'ftp', 'ftps']),
})

/** Error payload without secrets: fixed messages, certificate details and auth needs only. */
export const serializeFtpError = (error) => ({
  code: error?.code || 'EFTP',
  message: error?.message || 'The FTP operation failed',
  ...(typeof error?.path === 'string' ? { path: error.path } : {}),
})

export const createFtpManager = ({ connections, loadSettings, broadcast, ...options }) => new FtpConnectionManager({
  connections,
  loadProfile: async (id) => (await loadSettings()).connections?.find((profile) => profile.id === id),
  emitStatus: (event) => broadcast('ftp:status', event),
  ...options,
})

export const registerConnectionHandlers = (socket, { ftp }) => {
  socket.on('ftp:connect', async (payload, acknowledge) => {
    try {
      acknowledge?.({ ok: true, ...(await ftp.connect(payload?.profileId, payload?.password ?? '')) })
    } catch (error) {
      // Certificate details let the trust dialog ask for explicit trust;
      // they contain no secret.
      acknowledge?.({
        ok: false,
        error: serializeFtpError(error),
        ...(error?.certificate ? { certificate: error.certificate } : {}),
        ...(error?.auth ? { auth: error.auth } : {}),
      })
    }
  })
  socket.on('ftp:disconnect', (payload, acknowledge) => {
    ftp.disconnect(payload?.connectionId)
    acknowledge?.({ ok: true })
  })
  socket.on('ftp:status', (payload, acknowledge) => acknowledge?.({ ok: true, status: ftp.status(payload?.connectionId) }))
  socket.on('connections:capabilities', (_payload, acknowledge) => acknowledge?.({ ok: true, capabilities: { ...NODE_CONNECTION_CAPABILITIES, protocols: [...NODE_CONNECTION_CAPABILITIES.protocols] } }))
  for (const event of ['connections:credential-status', 'connections:forget-credential']) {
    socket.on(event, (_payload, acknowledge) => acknowledge?.({ ok: false, error: { code: 'ECREDENTIAL_UNAVAILABLE', message: 'Secure credential storage is available in the native app' } }))
  }
}
