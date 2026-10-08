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

export const installNativeEditHistory = () => {
  if (!isTauriRuntime()) return () => {}
  let disposed = false, unlisten
  void listen('vesperwind:edit-history', ({ payload }) => {
    if (!document.hasFocus()) return
    if (!['undo', 'redo'].includes(payload)) return
    const event = new CustomEvent('vesperwind:native-edit-history', { detail: payload, cancelable: true })
    if (window.dispatchEvent(event)) document.execCommand(payload)
  }).then((stop) => { if (disposed) stop(); else unlisten = stop }).catch(() => {})
  return () => { disposed = true; unlisten?.() }
}
