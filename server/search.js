import { wildcardMatch } from '../shared/wildcard.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideRoot, verifyRealPathInsideRoot, serializeFilesystemError } from './filesystem.js'

export const MAX_SEARCH_RESULTS = 10_000
const BATCH_SIZE = 25
const skippedError = (error) => ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EOUTSIDE_ROOT'].includes(error?.code)

export const searchMatches = (name, relativePath, query) => {
  const needle = String(query || '').trim()
  if (!needle) return false
  const candidates = [name, relativePath].map((value) => value.toLocaleLowerCase())
  if (!/[?*]/.test(needle)) return candidates.some((value) => value.includes(needle.toLocaleLowerCase()))
  return candidates.some((value) => wildcardMatch(value, needle))
}

const metadataFor = async (entryPath, isDirectory) => {
  try {
    const stats = await fs.lstat(entryPath)
    return { size: isDirectory ? null : stats.size, modifiedAt: stats.mtime.toISOString() }
  } catch { return { size: null, modifiedAt: null } }
}

export const searchLocal = async ({ basePath, query, type = 'all', maxResults = MAX_SEARCH_RESULTS, hiddenNameSuffixes = [], signal, onBatch }) => {
  const base = resolveInsideRoot(basePath)
  await verifyRealPathInsideRoot(base)
  const pending = [base]
  let batch = []
  let count = 0
  let limited = false
  const flush = async () => { if (batch.length) { const current = batch; batch = []; await onBatch(current) } }
  while (pending.length && !signal?.aborted) {
    const directory = pending.pop()
    let reader
    try { reader = await fs.opendir(directory) }
    catch (error) { if (skippedError(error)) continue; throw error }
    try {
      for await (const item of reader) {
        if (signal?.aborted) break
        const entryPath = path.join(directory, item.name)
        const relativePath = path.relative(base, entryPath)
        const isDirectory = item.isDirectory()
        // Never follow symlinks, including symlinked directories outside the configured root.
        if (isDirectory && !item.isSymbolicLink()) pending.push(entryPath)
        if (hiddenNameSuffixes.some((suffix) => item.name.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()))) continue
        if ((type === 'files' && isDirectory) || (type === 'folders' && !isDirectory)) continue
        if (!searchMatches(item.name, relativePath, query)) continue
        if (count >= maxResults) { limited = true; break }
        batch.push({ name: item.name, path: entryPath, relativePath, type: isDirectory ? 'directory' : 'file', isDirectory, isSymbolicLink: item.isSymbolicLink(), ...await metadataFor(entryPath, isDirectory) })
        count += 1
        if (batch.length >= BATCH_SIZE) await flush()
      }
    } catch (error) { if (!skippedError(error)) throw error }
    finally { try { await reader.close() } catch {} }
    if (limited) break
  }
  await flush()
  return { count, limited, cancelled: Boolean(signal?.aborted) }
}

const listRemoteWithTimeout = (connection, directory, signal) => new Promise((resolve, reject) => {
  let settled = false
  const complete = (callback, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    callback(value)
  }
  const abort = () => complete(reject, Object.assign(new Error('Search cancelled'), { code: 'ESEARCH_CANCELLED' }))
  const timer = setTimeout(() => complete(reject, Object.assign(new Error('Remote folder did not respond'), { code: 'ETIMEDOUT' })), 20_000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) { abort(); return }
  Promise.resolve().then(() => connection.list(directory)).then((entries) => complete(resolve, entries), (error) => complete(reject, error))
})

export const searchRemote = async ({ connection, basePath, query, type = 'all', maxResults = MAX_SEARCH_RESULTS, hiddenNameSuffixes = [], signal, onBatch }) => {
  const base = connection.resolve(basePath)
  const pending = [base]
  let batch = []
  let count = 0
  let limited = false
  const flush = async () => { if (batch.length) { const current = batch; batch = []; await onBatch(current) } }
  while (pending.length && !signal?.aborted) {
    const directory = pending.pop()
    let entries
    try { entries = await listRemoteWithTimeout(connection, directory, signal) }
    catch (error) { if (signal?.aborted) break; if (skippedError(error)) continue; throw error }
    for (const entry of entries) {
      if (signal?.aborted) break
      if (entry.isDirectory && !entry.isSymbolicLink) pending.push(entry.path)
      if (hiddenNameSuffixes.some((suffix) => entry.name.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()))) continue
      if ((type === 'files' && entry.isDirectory) || (type === 'folders' && !entry.isDirectory)) continue
      const relativePath = path.posix.relative(base, entry.path)
      if (!searchMatches(entry.name, relativePath, query)) continue
      if (count >= maxResults) { limited = true; break }
      batch.push({ ...entry, relativePath })
      count += 1
      if (batch.length >= BATCH_SIZE) await flush()
    }
    if (limited) break
  }
  await flush()
  return { count, limited, cancelled: Boolean(signal?.aborted) }
}

export const registerSearchHandlers = (socket, { ssh }) => {
  const jobs = new Map()
  socket.on('filesystem:search', (payload, acknowledge) => {
    const { searchId, filesystemId = 'local', basePath, query, type = 'all' } = payload || {}
    if (typeof searchId !== 'string' || !searchId || !String(query || '').trim() || !['all', 'files', 'folders'].includes(type)) {
      acknowledge?.({ ok: false, error: { code: 'EINVAL', message: 'Invalid search request' } })
      return
    }
    const controller = new AbortController()
    jobs.set(searchId, controller)
    acknowledge?.({ ok: true, searchId })
    setImmediate(async () => {
      try {
        const options = { basePath, query, type, maxResults: Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(payload.maxResults) || MAX_SEARCH_RESULTS)), hiddenNameSuffixes: payload.hiddenNameSuffixes || [], signal: controller.signal, onBatch: (entries) => { if (!controller.signal.aborted) socket.emit('filesystem:search-results', { searchId, entries }) } }
        const result = filesystemId === 'local'
          ? await searchLocal(options)
          : await searchRemote({ ...options, connection: await ssh.ensure(filesystemId) })
        socket.emit('filesystem:search-results', { searchId, done: true, ...result })
      } catch (error) {
        socket.emit('filesystem:search-results', { searchId, done: true, error: serializeFilesystemError(error, basePath) })
      } finally { jobs.delete(searchId) }
    })
  })
  socket.on('filesystem:search-cancel', ({ searchId } = {}, acknowledge) => {
    jobs.get(searchId)?.abort()
    acknowledge?.({ ok: true })
  })
  socket.on('disconnect', () => { for (const job of jobs.values()) job.abort(); jobs.clear() })
}
