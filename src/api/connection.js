import { backend } from './backend.js'

export const connection = Object.freeze({
  isConnected: () => backend.isConnected(),
  onStatusChange: (callback) =>
    backend.subscribeToConnection(callback),
})
