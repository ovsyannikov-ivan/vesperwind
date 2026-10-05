import { normalizeFilesystemPath } from './filesystemPath.js'
import { traceMedia } from '../api/mediaDiagnostics.js'

let consumerId = 0
const identity = ({ providerId, path }) => `${providerId}\0${normalizeFilesystemPath(path)}`

export const createDirectoryListing = ({ state, getLocation, isActive = () => true, list, onLoaded = () => {}, consumer = 'tree' }) => {
  const id = `${consumer}:${++consumerId}`
  let revision = 0
  let controller = null
  let disposed = false
  let successfulIdentity = null
  const invalidate = () => { revision++; controller?.abort(); controller = null; state.loading = false }
  const reset = () => {
    invalidate(); successfulIdentity = null
    Object.assign(state, { loaded: false, children: [], error: null, sourceEntryCount: 0 })
  }
  const load = async ({ force = false } = {}) => {
    if (disposed || !isActive()) return false
    const location = { ...getLocation() }
    const key = identity(location)
    if (!force && state.loaded && successfulIdentity === key) return true
    if (successfulIdentity && successfulIdentity !== key) reset()
    invalidate()
    const current = revision
    const request = new AbortController()
    controller = request
    state.loading = true; state.error = null
    const valid = () => !disposed && isActive() && !request.signal.aborted && current === revision && identity(getLocation()) === key
    traceMedia('directory.request', { consumer: id, ...location, revision: current })
    try {
      const response = await list(location.path, { signal: request.signal, providerId: location.providerId })
      traceMedia('directory.response', { consumer: id, ...location, revision: current, ok: response?.ok,
        entries: response?.entries?.length, sourceEntries: response?.sourceEntryCount, current: valid() })
      if (!valid()) return false
      if (!response?.ok || !Array.isArray(response.entries)) {
        state.error = response?.error || { message: 'Unable to refresh this folder' }
        return false
      }
      const previous = state.children
      state.children = response.entries
      state.sourceEntryCount = response.sourceEntryCount ?? response.entries.length
      state.loaded = true; successfulIdentity = key
      onLoaded({ ...location, entries: response.entries, previous, revision: current })
      traceMedia('directory.applied', { consumer: id, ...location, revision: current, entries: state.children.length })
      return true
    } catch (error) {
      if (valid()) state.error = { code: error?.code, message: error?.message || 'Unable to refresh this folder' }
      return false
    } finally {
      if (current === revision) { state.loading = false; controller = null }
    }
  }
  return { load, invalidate, reset, dispose() { disposed = true; invalidate() } }
}
