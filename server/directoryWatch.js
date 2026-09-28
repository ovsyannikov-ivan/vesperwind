import fs from 'node:fs'
import { promises as files } from 'node:fs'
import { resolveInsideRoot, verifyRealPathInsideRoot, serializeFilesystemError } from './filesystem.js'

export const createLocalWatchRegistry = ({ watch = fs.watch } = {}) => {
  const watches = new Map()

  const subscribe = async (socket, requestedPath) => {
    const logicalPath = resolveInsideRoot(requestedPath)
    const physicalPath = await verifyRealPathInsideRoot(logicalPath)
    if (!(await files.stat(physicalPath)).isDirectory()) {
      const error = new Error('This item is not a folder')
      error.code = 'ENOTDIR'
      throw error
    }
    let record = watches.get(physicalPath)
    if (!record) {
      record = { watcher: null, consumers: new Map() }
      const notify = (error) => {
        for (const [consumer, paths] of record.consumers) {
          for (const directoryPath of paths) {
            consumer.emit('filesystem:changed', { providerId: 'local', directoryPath,
              kind: 'changed', ...(error ? { error: serializeFilesystemError(error, directoryPath) } : {}) })
          }
        }
      }
      record.watcher = watch(physicalPath, { persistent: false }, () => {
        notify()
        void files.stat(physicalPath).catch((error) => {
          notify(error)
          record.watcher.close()
          watches.delete(physicalPath)
        })
      })
      record.watcher.on('error', (error) => {
        console.error(`Filesystem watcher failed for ${physicalPath}:`, error)
        notify(error)
        record.watcher.close()
        watches.delete(physicalPath)
      })
      watches.set(physicalPath, record)
    }
    if (!record.consumers.has(socket)) record.consumers.set(socket, new Set())
    record.consumers.get(socket).add(logicalPath)
    return { ok: true }
  }

  const unsubscribe = (socket, requestedPath) => {
    for (const [physicalPath, record] of watches) {
      const paths = record.consumers.get(socket)
      if (!paths) continue
      if (requestedPath) paths.delete(requestedPath)
      else paths.clear()
      if (!paths.size) record.consumers.delete(socket)
      if (!record.consumers.size) {
        record.watcher.close()
        watches.delete(physicalPath)
      }
    }
  }

  return { subscribe, unsubscribe, size: () => watches.size }
}

export const registerDirectoryWatchHandlers = (socket, registry) => {
  const desired = new Set()
  socket.on('filesystem:watch', async (payload, acknowledge) => {
    if (payload?.filesystemId !== 'local') {
      acknowledge?.({ ok: false, error: { code: 'EFILESYSTEM_ID', message: 'Only local directories can be watched' } })
      return
    }
    const requestedPath = payload?.path
    desired.add(requestedPath)
    try {
      const result = await registry.subscribe(socket, requestedPath)
      if (!desired.has(requestedPath) || !socket.connected) registry.unsubscribe(socket, requestedPath)
      acknowledge?.(result)
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeFilesystemError(error, requestedPath) })
    }
  })
  socket.on('filesystem:unwatch', (payload, acknowledge) => {
    if (payload?.filesystemId !== 'local') {
      acknowledge?.({ ok: false, error: { code: 'EFILESYSTEM_ID', message: 'Only local directories can be watched' } })
      return
    }
    const requestedPath = payload?.path
    desired.delete(requestedPath)
    registry.unsubscribe(socket, requestedPath)
    acknowledge?.({ ok: true })
  })
  socket.on('disconnect', () => {
    desired.clear()
    registry.unsubscribe(socket)
  })
}
