import { listen } from '@tauri-apps/api/event'
import { isTauriRuntime } from './backend.js'

export const onNativeOpenSettings = (callback) => {
  if (!isTauriRuntime()) return () => {}

  let disposed = false
  let unlisten = null
  void listen('vesperwind:open-settings', callback)
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(() => {})

  return () => {
    disposed = true
    unlisten?.()
  }
}
