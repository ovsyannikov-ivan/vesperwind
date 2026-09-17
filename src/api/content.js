import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'
import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'

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

const prepare = async (fileRef, { signal, onStatus } = {}) => {
  const payload = {
    filesystemId: fileRef?.providerId || LOCAL_FILESYSTEM_PROVIDER,
    path: fileRef?.path,
  }
  let operationId = null

  try {
    let response = normalize(await backend.request('content:prepare', payload))

    while (response.ok && response.preparation?.state === 'MATERIALIZING') {
      operationId = response.preparation.operationId
      onStatus?.(response.preparation)
      await waitForPoll(signal)
      response = normalize(
        await backend.request('content:status', { operationId }),
      )
    }

    if (response.ok) onStatus?.(response.preparation)
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
      void backend.request('content:cancel', { operationId })
    }
  }
}

export const content = Object.freeze({ prepare })
