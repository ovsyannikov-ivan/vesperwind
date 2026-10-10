import { io } from 'socket.io-client'

const DEFAULT_REQUEST_TIMEOUT = 15_000

let socket = null

const getSocket = () => {
  socket ||= io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  })

  return socket
}

export const createSocketRequester = (socketOf) => (eventName, payload = {}, options = {}) => {
  if (eventName === 'content:prepare') {
    return Promise.resolve({
      ok: true,
      preparation: {
        state: 'READY',
        operationId: null,
        progress: 1,
        userMessage: 'File is ready',
        elapsedMs: 0,
      },
    })
  }

  if (eventName === 'content:cancel') {
    return Promise.resolve({ ok: true, cancelled: false })
  }

  // File operations carry an id; on their deadline or a user cancel the
  // backend is told to stop the operation (remote transfers, partial files).
  const cancellable = eventName === 'filesystem:operate'
  const operationId = cancellable ? newOperationId() : null
  const args = cancellable ? { ...payload, operationId } : payload
  return new Promise((resolve) => {
    const timeout = options.timeout || DEFAULT_REQUEST_TIMEOUT
    let settled = false
    const finish = (response) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      resolve(response)
    }
    const stop = (code, message) => {
      if (settled) return
      if (cancellable) socketOf().emit('filesystem:operation-cancel', { operationId })
      finish({ ok: false, error: { code, message } })
    }
    const abort = () => stop('ECANCELLED', 'The operation was cancelled')
    if (options.signal?.aborted) { abort(); return }
    options.signal?.addEventListener('abort', abort, { once: true })

    socketOf().timeout(timeout).emit(eventName, args, (timeoutError, response) => {
      if (timeoutError) {
        stop('ETIMEDOUT', 'The backend did not respond')
        return
      }

      finish(response)
    })
  })
}

const newOperationId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const request = createSocketRequester(getSocket)

const send = (eventName, payload = {}) => {
  getSocket().emit(eventName, payload)
}

const subscribe = (eventName, callback) => {
  const activeSocket = getSocket()
  activeSocket.on(eventName, callback)

  return () => activeSocket.off(eventName, callback)
}

const subscribeToConnection = (callback) => {
  const activeSocket = getSocket()
  const handleConnect = () => callback(true)
  const handleDisconnect = () => callback(false)

  activeSocket.on('connect', handleConnect)
  activeSocket.on('disconnect', handleDisconnect)

  return () => {
    activeSocket.off('connect', handleConnect)
    activeSocket.off('disconnect', handleDisconnect)
  }
}

const getMediaUrl = ({ path, providerId = 'local' } = {}) => {
  let url = `/api/media?path=${encodeURIComponent(path || '')}`

  if (providerId !== 'local') {
    url += `&filesystemId=${encodeURIComponent(providerId)}`
  }

  return url
}

const getPreparedMediaSource = async (location) => ({
  ok: true,
  source: getMediaUrl(location),
})

export const socketTransport = Object.freeze({
  isConnected: () => getSocket().connected,
  request,
  send,
  subscribe,
  subscribeToConnection,
  getMediaUrl,
  getPreparedMediaSource,
})
