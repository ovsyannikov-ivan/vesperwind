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

const request = (eventName, payload = {}, options = {}) => {
  if (eventName === 'runtime:info') {
    return Promise.resolve({
      ok: true,
      runtime: 'node',
      version: '0.1.0',
      buildTimestamp: null,
      gitCommit: null,
    })
  }

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

  return new Promise((resolve) => {
    const timeout = options.timeout || DEFAULT_REQUEST_TIMEOUT

    getSocket().timeout(timeout).emit(eventName, payload, (timeoutError, response) => {
      if (timeoutError) {
        resolve({
          ok: false,
          error: {
            code: 'ETIMEDOUT',
            message: 'The backend did not respond',
          },
        })
        return
      }

      resolve(response)
    })
  })
}

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
