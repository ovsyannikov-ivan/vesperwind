import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { content } from './content.js'
import { permissionsApi } from './permissions.js'

const request = async (event, payload, options = {}) => normalizeApiResponse(
  await backend.request(event, payload, { timeout: 35_000, ...options }), 'ESQLITE', 'Unable to access this database',
)
export const sqlite = Object.freeze({
  async open(location, options = {}) {
    if (location.providerId !== 'local') return { ok: false, error: { code: 'ENOTSUPPORTED', message: 'SQLite editing currently supports local files, mounted disks and shares' } }
    const access = await permissionsApi.prepareFolder(location, options)
    if (!access.ok) return access
    const prepared = await content.prepare(location, options)
    if (!prepared.ok) return prepared
    if (options.signal?.aborted) return { ok: false, error: { code: 'ECANCELLED', message: 'Opening cancelled' } }
    const sessionId = crypto.randomUUID()
    // Always receive the open response so a tab closed during validation cannot leak a session.
    const response = await request('sqlite:open', { sessionId, filesystemId: location.providerId, path: location.path })
    if (options.signal?.aborted || !response.ok) {
      await request('sqlite:close', { sessionId })
      return options.signal?.aborted ? { ok: false, error: { code: 'ECANCELLED', message: 'Opening cancelled' } } : response
    }
    return { ...response, sessionId }
  },
  async run(sessionId, action, payload = {}, options = {}) {
    const cancel = () => { void request('sqlite:cancel', { sessionId }) }
    if (options.signal?.aborted) { cancel(); return { ok: false, error: { code: 'ECANCELLED', message: 'Query cancelled' } } }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const response = await request('sqlite:request', { sessionId, action, ...payload })
      if (response.error?.code === 'ETIMEDOUT') cancel()
      return response
    } finally { options.signal?.removeEventListener('abort', cancel) }
  },
  close: sessionId => sessionId ? request('sqlite:close', { sessionId }) : Promise.resolve({ ok: true }),
})
