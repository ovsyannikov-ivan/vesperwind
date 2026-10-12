import { reactive } from 'vue'

export const AUTO_DIFF_LINES = 400
export const AUTO_DIFF_BYTES = 128 * 1024
const CACHE_BYTES = 8 * 1024 * 1024
const CACHE_FILES = 32
const fileKey = (file) => `${file.scope}\0${file.path}`

// A tab owns one collection. Only expanded files near the viewport load;
// explicit requests unlock large patches. Old generations never replace a
// newer worktree snapshot or another commit's sections.
export const createGitDiffs = ({ load, concurrency = 2 }) => {
  const records = reactive(new Map())
  const pending = new Set()
  let context = 'working',
    running = 0,
    clock = 0,
    stopped = false,
    paused = false
  const isLarge = (record) =>
    record.deferred ||
    record.file.additions + record.file.deletions >= AUTO_DIFF_LINES
  const eligible = (record) =>
    !stopped &&
    !paused &&
    records.get(record.key) === record &&
    record.expanded &&
    record.near &&
    !record.file.binary &&
    !record.file.oversized &&
    (!isLarge(record) || record.manual)
  const evict = () => {
    const cached = [...records.values()].filter((record) => record.result)
    let bytes = cached.reduce((sum, record) => sum + record.bytes, 0),
      count = cached.length
    for (const record of cached
      .filter((record) => !record.near || !record.expanded)
      .sort((a, b) => a.touched - b.touched)) {
      if (bytes <= CACHE_BYTES && count <= CACHE_FILES) break
      bytes -= record.bytes
      count--
      record.result = null
      record.bytes = 0
      record.needsLoad = true
    }
  }
  const enqueue = (record) => {
    if (eligible(record) && record.needsLoad && !record.loading)
      pending.add(record.key)
    pump()
  }
  const pump = () => {
    while (!stopped && running < concurrency && pending.size) {
      const key = pending.values().next().value
      pending.delete(key)
      const record = records.get(key)
      if (!record || !eligible(record) || !record.needsLoad || record.loading)
        continue
      const revision = record.revision,
        selectedContext = context,
        file = { ...record.file }
      record.loading = true
      record.needsLoad = false
      record.error = null
      running++
      Promise.resolve()
        .then(() => load(file, selectedContext))
        .then((result) => {
          if (
            stopped ||
            context !== selectedContext ||
            records.get(key) !== record ||
            revision !== record.revision
          )
            return
          if (!result?.ok) {
            record.error = result?.error || {
              message: 'Unable to load this diff',
            }
            return
          }
          const bytes = new TextEncoder().encode(result.patch || '').byteLength
          const lines = (result.patch || '').split('\n').length
          if (
            !record.manual &&
            (bytes > AUTO_DIFF_BYTES || lines >= AUTO_DIFF_LINES * 2)
          ) {
            record.deferred = true
            record.result = null
            record.bytes = 0
            record.needsLoad = true
            return
          }
          if (JSON.stringify(record.result) !== JSON.stringify(result))
            record.result = result
          record.bytes = bytes
          record.touched = ++clock
          evict()
        })
        .catch((error) => {
          if (
            !stopped &&
            context === selectedContext &&
            records.get(key) === record &&
            revision === record.revision
          )
            record.error = { message: error.message }
        })
        .finally(() => {
          record.loading = false
          running--
          if (!stopped && records.get(key) === record) enqueue(record)
          pump()
        })
    }
  }
  const sync = (files, selectedContext, { refresh = false } = {}) => {
    if (stopped) return
    paused = false
    if (context !== selectedContext) {
      context = selectedContext
      records.clear()
      pending.clear()
    }
    const wanted = new Set(files.map(fileKey))
    for (const [key, record] of records)
      if (!wanted.has(key)) {
        record.revision++
        records.delete(key)
        pending.delete(key)
      }
    for (const file of files) {
      const key = fileKey(file)
      let record = records.get(key)
      if (!record) {
        records.set(key, {
          key,
          file: { ...file },
          expanded: true,
          near: false,
          manual: false,
          deferred: false,
          result: null,
          error: null,
          loading: false,
          needsLoad: true,
          revision: 0,
          bytes: 0,
          touched: 0,
        })
        record = records.get(key)
      } else {
        Object.assign(record.file, file)
        if (refresh) {
          record.revision++
          record.needsLoad = true
        }
      }
      enqueue(record)
    }
  }
  return {
    records,
    fileKey,
    isLarge,
    sync,
    invalidate: () => {
      paused = true
      pending.clear()
      for (const record of records.values()) {
        record.revision++
        record.needsLoad = true
      }
    },
    setNear: (key, near) => {
      const record = records.get(key)
      if (record) {
        record.near = near
        record.touched = ++clock
        enqueue(record)
        evict()
      }
    },
    toggle: (key) => {
      const record = records.get(key)
      if (record) {
        record.expanded = !record.expanded
        enqueue(record)
        evict()
      }
    },
    load: (key) => {
      const record = records.get(key)
      if (record) {
        record.manual = true
        record.expanded = true
        record.needsLoad = true
        enqueue(record)
      }
    },
    dispose: () => {
      stopped = true
      pending.clear()
      records.clear()
    },
  }
}
