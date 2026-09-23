import { emitTo, listen } from '@tauri-apps/api/event'
import { backend, isTauriRuntime } from './backend.js'

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
  onAction: (callback) => subscribe('media-overlay:action', callback),
  onContext: (callback) => subscribe('media-overlay:context', callback),
  snapshot: () => backend.request('player:overlay-snapshot'),
  sendAction: (action) => {
    if (!isTauriRuntime()) return Promise.resolve()
    return emitTo('main', 'media-overlay:action', { action })
  },
})
