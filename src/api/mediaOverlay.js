import { emitTo, listen } from '@tauri-apps/api/event'
import { backend, isTauriRuntime } from './backend.js'

const fade = async (covered, { immediate = false, viewport = null } = {}) => {
  if (!isTauriRuntime()) return
  const id = crypto.randomUUID()
  let unlisten
  let timer
  let resolveAck
  let rejectAck
  const acknowledgement = new Promise((resolve, reject) => {
    resolveAck = resolve
    rejectAck = reject
  })
  try {
    unlisten = await listen('media-overlay:transition-complete', ({ payload }) => {
      if (payload?.id !== id) return
      if (payload.error) rejectAck(new Error(payload.error))
      else resolveAck()
    })
    timer = setTimeout(() => rejectAck(new Error('Media transition did not respond')), 2000)
    await emitTo('media-overlay', 'media-overlay:transition', { id, covered, immediate, viewport })
    await acknowledgement
  } finally {
    clearTimeout(timer)
    unlisten?.()
  }
}

const subscribe = (eventName, callback) => {
  if (!isTauriRuntime()) return () => {}

  let disposed = false
  let unlisten = null

  void listen(eventName, (event) => callback(event.payload))
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    .catch(() => {})

  return () => {
    disposed = true
    unlisten?.()
  }
}

export const mediaOverlay = Object.freeze({
  fade,
  onTransition: (callback) => subscribe('media-overlay:transition', callback),
  completeTransition: (id, error) => emitTo('main', 'media-overlay:transition-complete', { id, error }),
  onAction: (callback) => subscribe('media-overlay:action', callback),
  onContext: (callback) => subscribe('media-overlay:context', callback),
  snapshot: () => backend.request('player:overlay-snapshot'),
  sendAction: (action) => {
    if (!isTauriRuntime()) return Promise.resolve()
    return emitTo('main', 'media-overlay:action', { action })
  },
})
