import { backend } from './backend.js'
import { validateArchiveRequest } from '../../shared/archivePolicy.js'
export const createArchiveClient = (transport) => (request, onEvent) => {
  const jobId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  let active = true, cancelled = false, dispatched = false
  const unsubscribe = transport.subscribe('archive:progress', (event) => {
    if (!active || event?.jobId !== jobId) return
    onEvent(event)
    if (event.done) { active = false; unsubscribe() }
  })
  const started = Promise.resolve(unsubscribe.ready ?? true).then(async (ready) => {
    const invalid = validateArchiveRequest(request)
    if (invalid) return { ok: false, error: invalid }
    if (!ready) return { ok: false, error: { code: 'EARCHIVE_LISTENER', message: 'Archive progress is unavailable' } }
    if (cancelled) return { ok: false, error: { code: 'ECANCELLED', message: 'Archive operation cancelled' } }
    dispatched = true
    const response = await transport.request('archive:start', { ...request, jobId })
    if (cancelled && response?.ok) await transport.request('archive:cancel', { jobId })
    return response
  }).catch((error) => ({ ok: false, error: { code: 'EARCHIVE_START', message: error?.message || 'Archive operation could not start' } }))
    .then((response) => {
      if (!response?.ok && active) { onEvent({ jobId, done: true, error: response.error }); active = false; unsubscribe() }
      return response
    })
  return { jobId, started,
    cancel: () => { if (!active) return; cancelled = true; if (dispatched) void transport.request('archive:cancel', { jobId }) },
    dispose: () => { if (!active) return; cancelled = true; active = false; unsubscribe(); if (dispatched) void transport.request('archive:cancel', { jobId }) },
  }
}
export const startArchiveOperation = createArchiveClient(backend)
