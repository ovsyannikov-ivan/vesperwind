import { backend } from './backend.js'
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
      const record = directories.get(keyOf(event?.providerId, event?.directoryPath))
      if (!record) return
      if (event.error) console.error('Filesystem watcher stopped', event)
      clearTimeout(record.timer)
      record.timer = setTimeout(() => {
        record.timer = null
        for (const callback of [...record.consumers]) callback(event)
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
