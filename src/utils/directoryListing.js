import { normalizeFilesystemPath } from './filesystemPath.js'
import { traceMedia } from '../api/mediaDiagnostics.js'

let consumerId = 0
const identity = ({ providerId, path }) => `${providerId}\0${normalizeFilesystemPath(path)}`

// Cloud status fields arrive after the listing. They are written onto the
// existing entry objects, so rows, keys, sorting and selection stay intact.
export const CLOUD_STATUS_FIELDS = Object.freeze(['contentAvailability', 'cloudSync'])
const isStatusCandidate = (entry) => entry && !entry.isDirectory && !entry.metadataError
const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
const unchangedEntry = (previous, next) => previous.modifiedAt === next.modifiedAt &&
  previous.size === next.size && previous.isDirectory === next.isDirectory

export const applyCloudStatus = (entry, status = {}) => {
  for (const field of CLOUD_STATUS_FIELDS) {
    const value = status[field]
    if (value == null) { if (field in entry) delete entry[field] }
    else if (!sameValue(entry[field], value)) entry[field] = value
  }
}

// `cloudStatus` ({ supports(location), inspect(request) }) adds lazy cloud
// status to a successful listing. Each listing generation has its own scan:
// any new load, collapse, location change or dispose aborts it, and late
// results are checked against the generation and the entry before use.
export const createDirectoryListing = ({ state, getLocation, isActive = () => true, list, onLoaded = () => {},
  consumer = 'tree', cloudStatus = null, statusOrder = () => [] }) => {
  const id = `${consumer}:${++consumerId}`
  let revision = 0
  let controller = null
  let statusController = null
  // path -> 'pending' | 'resolved' | 'failed' for the current generation.
  let statusStates = new Map()
  let disposed = false
  let successfulIdentity = null
  const stopStatus = () => { statusController?.abort(); statusController = null }
  const invalidate = () => { revision++; controller?.abort(); controller = null; stopStatus(); state.loading = false }
  const reset = () => {
    invalidate(); successfulIdentity = null; statusStates = new Map()
    Object.assign(state, { loaded: false, children: [], error: null, sourceEntryCount: 0 })
  }
  // A refresh keeps the status of unchanged entries until it is re-inspected,
  // so badges do not blink on every watcher event. Changed entries start empty.
  const carryStatus = (previous, entries) => {
    if (!cloudStatus || !previous?.length) return
    const byPath = new Map(previous.map((entry) => [entry.path, entry]))
    for (const entry of entries) {
      const old = byPath.get(entry.path)
      if (!old || !unchangedEntry(old, entry)) continue
      for (const field of CLOUD_STATUS_FIELDS) if (old[field] != null && entry[field] == null) entry[field] = old[field]
    }
  }
  const startStatus = async (location, generation, key) => {
    if (!cloudStatus) return
    const request = new AbortController()
    statusController = request
    const current = () => !disposed && !request.signal.aborted && generation === revision && successfulIdentity === key
    const byPath = new Map(state.children.map((entry) => [entry.path, entry]))
    const ordered = new Map()
    for (const entry of [...(statusOrder() || []), ...state.children]) {
      if (isStatusCandidate(entry) && byPath.get(entry.path) && !ordered.has(entry.path)) ordered.set(entry.path, byPath.get(entry.path))
    }
    const states = new Map([...ordered.keys()].map((path) => [path, 'pending']))
    statusStates = states
    try {
      if (!ordered.size || !(await cloudStatus.supports(location)) || !current()) {
        if (current()) for (const path of states.keys()) states.set(path, 'resolved')
        return
      }
      traceMedia('directory.status-start', { consumer: id, ...location, revision: generation, entries: ordered.size })
      await cloudStatus.inspect({ ...location, paths: [...ordered.keys()], signal: request.signal,
        onBatch: (paths, response) => {
          if (!current()) return
          const statuses = new Map(response?.ok && Array.isArray(response.statuses)
            ? response.statuses.map((status) => [status?.path, status]) : [])
          for (const path of paths) {
            const status = statuses.get(path)
            if (!response?.ok || status?.error) { states.set(path, 'failed'); continue }
            states.set(path, 'resolved')
            const entry = ordered.get(path)
            // Inspected metadata that no longer matches belongs to a replaced
            // file; the watcher refresh brings a new generation for it.
            if (status?.modifiedAt && entry.modifiedAt && status.modifiedAt !== entry.modifiedAt) continue
            applyCloudStatus(entry, status)
          }
          traceMedia('directory.status-batch', { consumer: id, ...location, revision: generation, entries: paths.length, ok: response?.ok })
        } })
    } catch (error) {
      if (current()) for (const [path, value] of states) if (value === 'pending') states.set(path, 'failed')
      traceMedia('directory.status-error', { consumer: id, ...location, revision: generation, error: error?.message })
    } finally {
      if (statusController === request) statusController = null
    }
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
      carryStatus(previous, response.entries)
      state.children = response.entries
      state.sourceEntryCount = response.sourceEntryCount ?? response.entries.length
      state.loaded = true; successfulIdentity = key
      onLoaded({ ...location, entries: response.entries, previous, revision: current })
      traceMedia('directory.applied', { consumer: id, ...location, revision: current, entries: state.children.length })
      void startStatus(location, current, key)
      return true
    } catch (error) {
      if (valid()) state.error = { code: error?.code, message: error?.message || 'Unable to refresh this folder' }
      return false
    } finally {
      if (current === revision) { state.loading = false; controller = null }
    }
  }
  return {
    load, invalidate, reset,
    statusOf: (path) => statusStates.get(path),
    dispose() { disposed = true; invalidate() },
  }
}
