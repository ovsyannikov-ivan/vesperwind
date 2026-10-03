import { watch } from 'vue'
import { runtime } from '../api/runtime.js'

export const installDesktopContextMenuPolicy = ({
  target = globalThis.document,
  runtimeState = runtime,
} = {}) => {
  if (!target) return () => {}

  // Capture before component handlers that stop bubbling, but leave propagation
  // intact so Vesperwind-owned menus still receive the right-click.
  const preventDefault = (event) => event.preventDefault()
  let installed = false
  const stop = watch(() => runtimeState.mode, (mode) => {
    const enabled = mode === 'sea' || mode === 'tauri'
    if (enabled === installed) return
    if (enabled) target.addEventListener('contextmenu', preventDefault, true)
    else target.removeEventListener('contextmenu', preventDefault, true)
    installed = enabled
  }, { immediate: true, flush: 'sync' })

  return () => {
    stop()
    if (installed) target.removeEventListener('contextmenu', preventDefault, true)
    installed = false
  }
}
