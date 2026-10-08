import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'
import { directoryWatch } from './directoryWatch.js'

const POLL_INTERVAL_MS = 600

const waitForPoll = (signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Content preparation was cancelled', 'AbortError'))
      return
    }

    const handleAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Content preparation was cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, POLL_INTERVAL_MS)
    signal?.addEventListener('abort', handleAbort, { once: true })
  })

const normalize = (response) =>
  normalizeApiResponse(
    response,
    'ECONTENT_PREPARE',
    'Unable to prepare this file',
  )

export const createContentPreparer = ({ request = backend.request, poll = waitForPoll,
  onMaterialized = (location) => directoryWatch.refreshFile(location) } = {}) => async (fileRef, { signal, onStatus } = {}) => {
  if (signal?.aborted) return { ok: false, error: { code: 'ECONTENT_CANCELLED', message: 'File preparation was cancelled' } }
  if (fileRef?.providerId && fileRef.providerId !== LOCAL_FILESYSTEM_PROVIDER) {
    const response = { ok: true, preparation: { state: 'READY', operationId: null, progress: 1, userMessage: 'Remote file is ready', elapsedMs: 0 } }
    onStatus?.(response.preparation)
    return response
  }
  const payload = {
    filesystemId: fileRef?.providerId || LOCAL_FILESYSTEM_PROVIDER,
    path: fileRef?.path,
  }
  let operationId = null
  let materializing = false

  try {
    let response = normalize(await request('content:prepare', payload))
    operationId = response.preparation?.operationId || null
    if (signal?.aborted) throw new DOMException('Content preparation was cancelled', 'AbortError')

    while (response.ok && response.preparation?.state === 'MATERIALIZING') {
      materializing = true
      operationId = response.preparation.operationId
      onStatus?.(response.preparation)
      await poll(signal)
      response = normalize(
        await request('content:status', { operationId }),
      )
      if (signal?.aborted) throw new DOMException('Content preparation was cancelled', 'AbortError')
    }

    if (response.ok) {
      if (materializing && response.preparation?.state === 'READY') {
        // Cloud provider metadata can settle after the last OS notification.
        // Refresh current entries once at completion; never poll directory rows.
        onMaterialized({ providerId: payload.filesystemId, path: payload.path })
      }
      onStatus?.(response.preparation)
    }
    return response
  } catch (error) {
    if (error?.name === 'AbortError') {
      return {
        ok: false,
        error: {
          code: 'ECONTENT_CANCELLED',
          message: 'File preparation was cancelled',
        },
      }
    }
    throw error
  } finally {
    if (operationId) {
      void request('content:cancel', { operationId }).catch(() => {})
    }
  }
}

export const content = Object.freeze({ prepare: createContentPreparer() })
