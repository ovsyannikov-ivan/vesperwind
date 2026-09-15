import { io } from 'socket.io-client'

const DEFAULT_REQUEST_TIMEOUT = 15_000

const socket = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
})

const request = (eventName, payload = {}, options = {}) =>
  new Promise((resolve) => {
    const timeout = options.timeout || DEFAULT_REQUEST_TIMEOUT

    socket.timeout(timeout).emit(eventName, payload, (timeoutError, response) => {
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

const send = (eventName, payload = {}) => {
  socket.emit(eventName, payload)
}

const subscribe = (eventName, callback) => {
  socket.on(eventName, callback)

  return () => socket.off(eventName, callback)
}

const subscribeToConnection = (callback) => {
  const handleConnect = () => callback(true)
  const handleDisconnect = () => callback(false)

  socket.on('connect', handleConnect)
  socket.on('disconnect', handleDisconnect)

  return () => {
    socket.off('connect', handleConnect)
    socket.off('disconnect', handleDisconnect)
  }
}

export const socketTransport = Object.freeze({
  isConnected: () => socket.connected,
  request,
  send,
  subscribe,
  subscribeToConnection,
})
