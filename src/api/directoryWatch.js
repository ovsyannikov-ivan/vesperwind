import { traceMedia } from './mediaDiagnostics.js'
import { backend } from './backend.js'
import { isComputerPath } from '../../shared/localFilesystem.js'
import { normalizeFilesystemPath } from '../utils/filesystemPath.js'

// One backend subscription per visible local directory, regardless of the number
// of panels and editor trees displaying it.
export const createDirectoryWatchRegistry = (transport, delay = 100) => {
  const directories = new Map()
  const operations = new Map()
  let unsubscribeEvents = null
  let unsubscribeConnection = null
  let disconnected = false

  const keyOf = (providerId, path) => `${providerId}\0${normalizeFilesystemPath(path)}`
  const queue = (record, action) => {
    const key = keyOf(record.providerId, record.path)
    const previous = operations.get(key) || Promise.resolve()
    const pending = previous.then(() => transport.request(`filesystem:${action}`, {
      filesystemId: record.providerId, path: record.path,
    })).then((response) => {
      if (!response?.ok) console.error(`Filesystem ${action} failed`, response?.error)
    }).catch((error) => console.error(`Filesystem ${action} failed`, error))
    operations.set(key, pending)
    void pending.finally(() => { if (operations.get(key) === pending) operations.delete(key) })
  }
  const ensureListeners = () => {
    if (unsubscribeEvents) return
    unsubscribeEvents = transport.subscribe('filesystem:changed', (event) => {
      traceMedia('directory.event', { providerId: event?.providerId, path: event?.directoryPath, kind: event?.kind, error: event?.error })
      const record = directories.get(keyOf(event?.providerId, event?.directoryPath))
      if (!record) return
      if (event.error) console.error('Filesystem watcher stopped', event)
      clearTimeout(record.timer)
      record.timer = setTimeout(() => {
        record.timer = null
        for (const callback of [...record.consumers]) {
          try { Promise.resolve(callback(event)).catch((error) => console.warn('Directory refresh failed', error)) }
          catch (error) { console.warn('Directory refresh failed', error) }
        }
      }, delay)
    })
    unsubscribeConnection = transport.subscribeToConnection?.((connected) => {
      if (!connected) disconnected = true
      if (connected && disconnected) {
        disconnected = false
        for (const record of directories.values()) {
          queue(record, 'watch')
        }
      }
    })
  }

  const subscribe = (providerId, path, callback) => {
    if (providerId !== 'local' || !path) return () => {}
    // Logical drives are not an OS directory. Poll their small inventory so
    // removable disks appear while This PC is open, without fs.watch.
    if (isComputerPath(path)) {
      let stopped = false
      let previous = null
      let busy = false
      const poll = async () => {
        if (busy || stopped) return
        busy = true
        try {
          const response = await transport.request('filesystem:list', { filesystemId: providerId, path })
          if (stopped || !response?.ok) return
          const signature = response.entries.map((entry) => entry.path).join('\0')
          if (previous !== null && signature !== previous) callback({ providerId, directoryPath: path })
          previous = signature
        } finally { busy = false }
      }
      const timer = setInterval(() => { void poll().catch(() => {}) }, 3000)
      void poll().catch(() => {})
      return () => { stopped = true; clearInterval(timer) }
    }
    ensureListeners()
    const key = keyOf(providerId, path)
    let record = directories.get(key)
    if (!record) {
      record = { providerId, path: normalizeFilesystemPath(path), consumers: new Set(), timer: null }
      directories.set(key, record)
      queue(record, 'watch')
    }
    record.consumers.add(callback)
    return () => {
      if (!record.consumers.delete(callback) || record.consumers.size) return
      clearTimeout(record.timer)
      directories.delete(key)
      queue(record, 'unwatch')
      if (!directories.size) {
        unsubscribeEvents?.()
        unsubscribeConnection?.()
        unsubscribeEvents = null
        unsubscribeConnection = null
      }
    }
  }

  return { subscribe, count: () => directories.size }
}

export const directoryWatch = createDirectoryWatchRegistry(backend)
