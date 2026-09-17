import { socketTransport } from './transports/socket.js'
import { tauriTransport } from './transports/tauri.js'

export const isTauriRuntime = () =>
  typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)

// Runtime selection lives at the API boundary so Vue code remains backend-agnostic.
export const backendRuntimeMode = isTauriRuntime() ? 'tauri' : 'browser'
export const backend =
  backendRuntimeMode === 'tauri' ? tauriTransport : socketTransport
