import { backend } from './backend.js'

// The Tauri event listener is asynchronous. Start traversal only when it is
// registered, otherwise a fast search can lose its first batch or completion.
export const createFilesystemSearchClient = (transport) => (request, onEvent) => {
  const searchId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  let active = true
  const unsubscribe = transport.subscribe('filesystem:search-results', (event) => {
    if (!active || event?.searchId !== searchId) return
    onEvent(event)
    if (event.done) { active = false; unsubscribe() }
  })
  const started = Promise.resolve(unsubscribe.ready ?? true)
    .then((ready) => {
      if (!active) return { ok: false, error: { code: 'ECANCELLED', message: 'Search cancelled' } }
      if (!ready) return { ok: false, error: { code: 'ESEARCH_LISTENER', message: 'Search events are unavailable' } }
      return transport.request('filesystem:search', { ...request, searchId }, { timeout: 30_000 })
    })
    .catch((error) => ({ ok: false, error: { message: error?.message || 'Search could not start' } }))
    .then((response) => {
      if (!response?.ok && active) {
        onEvent({ searchId, done: true, error: response?.error || { message: 'Search could not start' } })
        active = false
        unsubscribe()
      }
      return response
    })
  return {
    searchId,
    started,
    cancel: () => {
      if (!active) return
      active = false
      unsubscribe()
      void transport.request('filesystem:search-cancel', { searchId })
    },
  }
}

export const startFilesystemSearch = createFilesystemSearchClient(backend)
