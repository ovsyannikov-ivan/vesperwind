import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

const createSession = async ({ cols, rows, type = 'local', connectionId = null }) => {
  const response = normalizeApiResponse(
    await backend.request(
      'terminal:create',
      { cols, rows, type, connectionId },
      { timeout: 15_000 },
    ),
    'ETERMINAL_CREATE',
    'Unable to reach the terminal backend',
  )

  if (!response.ok) {
    return response
  }

  return {
    ok: true,
    sessionId: response.id,
    title: response.title || (type === 'local' ? 'Local' : connectionId),
    reused: response.reused === true,
  }
}

const onData = (callback) =>
  backend.subscribe('terminal:output', (payload) => {
    if (typeof payload?.data !== 'string') {
      return
    }

    callback({
      sessionId: payload.id,
      data: payload.data,
    })
  })

const onExit = (callback) =>
  backend.subscribe('terminal:exit', (payload) => {
    callback({
      sessionId: payload?.id,
      exitCode: payload?.exitCode,
      signal: payload?.signal,
      disconnected: payload?.disconnected === true,
    })
  })

export const terminal = Object.freeze({
  createSession,
  write: (sessionId, data) =>
    backend.send('terminal:input', { id: sessionId, data }),
  resize: (sessionId, cols, rows) =>
    backend.send('terminal:resize', { id: sessionId, cols, rows }),
  closeSession: (sessionId) =>
    backend.send('terminal:close', { id: sessionId }),
  onData,
  onExit,
})
