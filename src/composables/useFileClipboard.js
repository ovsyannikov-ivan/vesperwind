import { reactive, readonly } from 'vue'
import { fileClipboard, onShellEvent } from '../api/shellIntegration.js'
import { clipboardItem } from '../utils/fileClipboard.js'

// One clipboard view for every panel: menus enable Paste from it and rows
// dim Vesperwind Cut items. The backend stays authoritative; `refresh`
// re-reads it, so a clipboard replaced by another application is dropped.
const state = reactive({ snapshot: null, staging: null })
let subscribed = false

const refresh = async () => {
  const response = await fileClipboard.read()
  if (response.ok) state.snapshot = response.clipboard || null
  return response
}

const write = async (operation, entries) => {
  const items = entries.map(clipboardItem)
  const response = await (operation === 'cut' ? fileClipboard.cutFiles : fileClipboard.copyFiles)(items)
  if (response.ok) {
    const written = response.clipboard
    state.snapshot = { operation, items: written.items || items, token: written.token, source: 'vesperwind' }
    state.staging = written.staging ? { token: written.token, state: 'started' } : null
  }
  return response
}

const consume = async (token, operation) => {
  const response = await fileClipboard.consume({ token, operation })
  if (operation === 'cut') state.snapshot = null
  return response
}

const subscribe = (onNotice) => {
  if (subscribed) return () => {}
  subscribed = true
  const stops = [
    onShellEvent('clipboard:consumed', () => { void refresh() }),
    onShellEvent('clipboard:staging', (event) => {
      if (event?.token !== state.snapshot?.token) return
      state.staging = event
      if (['failed', 'skipped'].includes(event.state)) onNotice?.('Finder Paste unavailable', event.error)
    }),
  ]
  const focus = () => { void refresh() }
  window.addEventListener('focus', focus)
  return () => {
    subscribed = false
    stops.forEach((stop) => stop?.())
    window.removeEventListener('focus', focus)
  }
}

export const useFileClipboard = () => ({
  state: readonly(state),
  refresh,
  copy: (entries) => write('copy', entries),
  cut: (entries) => write('cut', entries),
  consume,
  subscribe,
})
