const fallback = (reason) => ({ ok: true, thumbnail: { status: 'unavailable', reason } })

// Small bounded hover LRU: one active extraction and one replaceable pending
// position. Native try_lock additionally bounds extraction across WebViews.
export const createThumbnailService = ({ generate, cancel = () => {}, maxEntries = 32, maxBytes = 4 * 1024 * 1024 }) => {
  const cache = new Map()
  let bytes = 0
  let active = null
  let pending = null
  let revision = 0
  const abortNative = (job) => {
    if (job.cancelSent) return
    job.cancelSent = true
    Promise.resolve().then(() => cancel(job.args.requestId)).catch(() => {})
  }
  const remember = (key, response) => {
    // Include UTF-16 string storage, rather than counting only JPEG bytes.
    const size = (response.thumbnail?.url?.length || 0) * 2
    if (!size || size > maxBytes || maxEntries < 1) return
    const old = cache.get(key)
    if (old) { bytes -= old.size; cache.delete(key) }
    cache.set(key, { response, size })
    bytes += size
    while (cache.size > maxEntries || bytes > maxBytes) {
      const oldest = cache.keys().next().value
      bytes -= cache.get(oldest).size
      cache.delete(oldest)
    }
  }
  const hit = (key) => {
    const item = cache.get(key)
    if (!item) return null
    cache.delete(key)
    cache.set(key, item)
    return item.response
  }
  const discard = (job, reason) => { job?.detach?.(); job?.resolve(fallback(reason)) }
  const drain = async () => {
    if (active || !pending) return
    const job = pending
    pending = null
    if (job.signal?.aborted || job.revision !== revision) { discard(job, 'cancelled'); return }
    const cached = hit(job.key)
    if (cached) { job.detach(); job.resolve(cached); return }
    active = job
    let response
    try { response = await generate(job.args) } catch { response = fallback('failed') }
    const stale = job.cancelSent || job.signal?.aborted || job.revision !== revision
    if (!stale && response?.thumbnail?.status === 'ready') remember(job.key, response)
    job.detach()
    job.resolve(stale ? fallback('cancelled') : response)
    active = null
    void drain()
  }
  return Object.freeze({
    getThumbnail({ path, time, width = 180, providerId = 'local', signal } = {}) {
      if (providerId !== 'local') return Promise.resolve(fallback('remote'))
      if (!path || !Number.isFinite(time) || time < 0) return Promise.resolve(fallback('invalid'))
      if (signal?.aborted) return Promise.resolve(fallback('cancelled'))
      const bucket = { path, time: Math.floor(time * 2) / 2, width: Math.max(64, Math.min(480, Math.round(width) || 180)), providerId }
      const key = JSON.stringify(bucket)
      const cached = hit(key)
      if (cached) return Promise.resolve(cached)
      return new Promise((resolve) => {
        discard(pending, 'superseded')
        const job = { args: { ...bucket, requestId: globalThis.crypto.randomUUID() }, key, signal, resolve, revision, cancelSent: false }
        const abort = () => {
          if (active === job) abortNative(job)
          if (pending === job) { pending = null; discard(job, 'cancelled') }
        }
        signal?.addEventListener('abort', abort, { once: true })
        job.detach = () => signal?.removeEventListener('abort', abort)
        pending = job
        void drain()
      })
    },
    clearCache() {
      revision++
      cache.clear()
      bytes = 0
      discard(pending, 'cancelled')
      pending = null
      if (active) abortNative(active)
    },
  })
}
