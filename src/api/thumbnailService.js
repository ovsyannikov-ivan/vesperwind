const fallback = (reason) => ({ ok: true, thumbnail: { status: 'unavailable', reason } })

// One active request and one replaceable pending request per service. The Rust
// manager additionally bounds concurrency across the main and overlay WebViews.
export const createThumbnailService = ({ generate, maxEntries = 32, maxBytes = 4 * 1024 * 1024 }) => {
  const cache = new Map()
  let bytes = 0
  let active = false
  let pending = null
  const remember = (key, response) => {
    const size = response.thumbnail?.url?.length || 0
    if (!size || size > maxBytes) return
    cache.set(key, { response, size })
    bytes += size
    while (cache.size > maxEntries || bytes > maxBytes) {
      const oldest = cache.keys().next().value
      bytes -= cache.get(oldest).size
      cache.delete(oldest)
    }
  }
  const drain = async () => {
    if (active || !pending) return
    const job = pending
    pending = null
    if (job.signal?.aborted) { job.resolve(fallback('cancelled')); void drain(); return }
    if (cache.has(job.key)) { job.resolve(cache.get(job.key).response); void drain(); return }
    active = true
    let response
    try { response = await generate(job.args) }
    catch { response = fallback('failed') }
    if (response?.thumbnail?.status === 'ready') remember(job.key, response)
    job.resolve(job.signal?.aborted ? fallback('cancelled') : response)
    active = false
    void drain()
  }
  return Object.freeze({
    getThumbnail({ path, time, width = 180, providerId = 'local', signal } = {}) {
      if (providerId !== 'local') return Promise.resolve(fallback('remote'))
      if (!path || !Number.isFinite(time) || time < 0) return Promise.resolve(fallback('invalid'))
      if (signal?.aborted) return Promise.resolve(fallback('cancelled'))
      const args = { path, time: Math.floor(time * 2) / 2, width: Math.max(64, Math.min(480, Math.round(width) || 180)) }
      const key = JSON.stringify(args)
      if (cache.has(key)) {
        const item = cache.get(key)
        cache.delete(key)
        cache.set(key, item)
        return Promise.resolve(item.response)
      }
      return new Promise((resolve) => {
        pending?.resolve(fallback('superseded'))
        pending = { args, key, resolve, signal }
        void drain()
      })
    },
    clearCache() { cache.clear(); bytes = 0 },
  })
}
