// The current runtime uses Socket.io. A future desktop build can replace this
// binding with a Tauri invoke/events adapter without changing domain APIs.
export { socketTransport as backend } from './transports/socket.js'
