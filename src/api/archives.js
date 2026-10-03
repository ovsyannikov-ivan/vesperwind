import { backend } from './backend.js'
import { validateArchiveRequest } from '../../shared/archivePolicy.js'
export const createArchiveClient = (transport) => (request, onEvent) => {
  const jobId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  let active = true, cancelled = false, dispatched = false, connectionLost = false
  let unsubscribe = () => {}, unsubscribeConnection = () => {}
  const finish = (event) => {
    if (!active) return
    active = false
    unsubscribe(); unsubscribeConnection()
    onEvent(event)
  }
  unsubscribe = transport.subscribe('archive:progress', (event) => {
    if (!active || event?.jobId !== jobId) return
    if (event.done) finish(event)
    else onEvent(event)
  })
  unsubscribeConnection = transport.subscribeToConnection?.((connected) => {
    if (connected || !active) return
    connectionLost = true; cancelled = true
    finish({ jobId, done: true, error: { code: 'ECONNECTION_LOST', message: 'Connection lost; archive operation was interrupted. Check the destination before retrying.' } })
  }) || (() => {})
  const started = Promise.resolve(unsubscribe.ready ?? true).then(async (ready) => {
    const invalid = validateArchiveRequest(request)
    if (invalid) return { ok: false, error: invalid }
    if (!ready) return { ok: false, error: { code: 'EARCHIVE_LISTENER', message: 'Archive progress is unavailable' } }
    if (cancelled) return { ok: false, error: { code: 'ECANCELLED', message: 'Archive operation cancelled' } }
    dispatched = true
    const response = await transport.request('archive:start', { ...request, jobId })
    if (cancelled && !connectionLost && response?.ok) await transport.request('archive:cancel', { jobId })
    return response
  }).catch((error) => ({ ok: false, error: { code: 'EARCHIVE_START', message: error?.message || 'Archive operation could not start' } }))
    .then((response) => {
      if (!response?.ok) finish({ jobId, done: true, error: response.error })
      return response
    })
  return { jobId, started,
    cancel: () => { if (!active) return; cancelled = true; if (dispatched) void transport.request('archive:cancel', { jobId }) },
    dispose: () => { if (!active) return; cancelled = true; active = false; unsubscribe(); unsubscribeConnection(); if (dispatched) void transport.request('archive:cancel', { jobId }) },
  }
}
export const startArchiveOperation = createArchiveClient(backend)
