import { backend } from './backend.js'

export const createSizeClient = (transport) => (location, onEvent) => {
  const jobId = globalThis.crypto.randomUUID()
  let active = true, unsubscribeConnection = null
  const detach = () => { active = false; unsubscribe(); unsubscribeConnection?.() }
  const unsubscribe = transport.subscribe('filesystem:size-progress', (event) => {
    if (!active || event?.jobId !== jobId) return
    onEvent(event)
    if (event.done) detach()
  })
  unsubscribeConnection = transport.subscribeToConnection?.((connected) => {
    if (!connected && active) {
      onEvent({ jobId, done: true, error: { code: 'EDISCONNECTED', message: 'The backend disconnected during size calculation' } })
      detach()
    }
  })
  const started = Promise.resolve(unsubscribe.ready ?? true).then((ready) => {
    if (!active) return { ok: false, error: { code: 'ECANCELLED', message: 'Calculation cancelled' } }
    if (!ready) return { ok: false, error: { code: 'ESIZE_LISTENER', message: 'Size events are unavailable' } }
    return transport.request('filesystem:calculate-size', { filesystemId: location.providerId || 'local', path: location.path, jobId })
  }).catch((e) => ({ ok: false, error: { message: e.message } })).then((result) => {
    if (!result?.ok && active) { onEvent({ jobId, done: true, error: result?.error || { message: 'Calculation could not start' } }); detach() }
    return result
  })
  return { jobId, started, cancel: () => {
    if (!active) return
    detach()
    void transport.request('filesystem:calculate-size-cancel', { jobId })
  } }
}
export const calculateSize = createSizeClient(backend)
