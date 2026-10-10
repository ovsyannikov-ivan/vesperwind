import { backend, backendRuntimeMode } from './backend.js'
import { runtime, runtimeInfoReady } from './runtime.js'
import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'

// Lazy iCloud/OneDrive status for a listed local folder (desktop app only).
// The listing never waits for it: batches start after the rows are painted,
// run a few at a time across every panel, and stop as soon as their listing
// is replaced, refreshed, collapsed or unmounted. Statuses are presentation
// only; opening a file still goes through content.prepare().
export const CLOUD_STATUS_BATCH_SIZE = 64
const CLOUD_STATUS_CONCURRENCY = 2
const CLOUD_STATUS_TIMEOUT = 60_000

// Let the browser paint before the next background step.
export const afterPaint = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0))
  else setTimeout(resolve, 0)
})

// At most `limit` tasks run at once. A task whose signal was aborted while it
// waited is skipped, so closed folders never reach the backend.
export const createLimiter = (limit) => {
  let active = 0
  const waiting = []
  return async (task, signal) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve))
    else active++
    try { return signal?.aborted ? null : await task() }
    finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

export const createCloudStatusInspector = ({
  request,
  supported = async () => true,
  batchSize = CLOUD_STATUS_BATCH_SIZE,
  concurrency = CLOUD_STATUS_CONCURRENCY,
  pause = afterPaint,
  newId = () => globalThis.crypto.randomUUID(),
}) => {
  const limit = createLimiter(concurrency)
  const requestBatch = async ({ providerId, path, paths, signal }) => {
    const requestId = newId()
    // The native batch stops between entries; the UI request settles at once.
    const cancel = () => { void Promise.resolve(request('filesystem:cloud-status-cancel', { requestId })).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await request('filesystem:cloud-status', {
        requestId, filesystemId: providerId, directoryPath: path, paths,
      }, { signal, timeout: CLOUD_STATUS_TIMEOUT })
    } catch (error) {
      return { ok: false, error: { code: error?.code || 'ECLOUD_STATUS', message: error?.message || 'Unable to inspect cloud status' } }
    } finally { signal.removeEventListener('abort', cancel) }
  }

  // Calls onBatch(paths, response) for every batch in order; a response with
  // `complete` resolves the remaining paths without asking the backend.
  const inspect = async ({ providerId, path, paths, signal, onBatch }) => {
    for (let start = 0; start < paths.length; start += batchSize) {
      await pause()
      if (signal.aborted) return
      const batch = paths.slice(start, start + batchSize)
      const response = await limit(() => requestBatch({ providerId, path, paths: batch, signal }), signal)
      if (signal.aborted) return
      onBatch(batch, response)
      if (response?.ok && response.complete) {
        const rest = paths.slice(start + batchSize)
        if (rest.length) onBatch(rest, { ok: true, statuses: [], complete: true })
        return
      }
    }
  }
  return Object.freeze({ supports: supported, inspect })
}

export const cloudStatus = createCloudStatusInspector({
  request: (event, payload, options) => backend.request(event, payload, options),
  supported: async ({ providerId } = {}) => {
    if (backendRuntimeMode !== 'tauri' || (providerId || LOCAL_FILESYSTEM_PROVIDER) !== LOCAL_FILESYSTEM_PROVIDER) return false
    await runtimeInfoReady()
    return runtime.capabilities.cloudStatus === true
  },
})
