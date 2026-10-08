import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideRoot, verifyRealPathInsideRoot, serializeFilesystemError, desktopFilesystem, fileManagerRoot } from './filesystem.js'

const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, (error, value) => error ? reject(error) : resolve(value)))
const error = (message, code = 'ENOTSUPPORTED') => Object.assign(new Error(message), { code })
const typeOf = (mode) => ({ [0o040000]: 'directory', [0o100000]: 'file', [0o120000]: 'symlink' })[mode & 0o170000] || 'unknown'
export const remoteProperties = (requested, stat, target = null) => {
  const type = typeOf(stat.mode), writable = ['file', 'directory'].includes(type)
  const date = (v) => v == null ? null : new Date(v * 1000).toISOString()
  return { name: path.posix.basename(requested) || '/', path: requested, type, size: type === 'directory' ? null : stat.size ?? null,
    createdAt: null, modifiedAt: date(stat.mtime), accessedAt: date(stat.atime), target,
    permissions: { mode: stat.mode ?? null, modeOctal: stat.mode == null ? null : (stat.mode & 0o7777).toString(8), uid: stat.uid ?? null, gid: stat.gid ?? null, ownerName: null, groupName: null },
    permissionsMessage: type === 'symlink' ? 'Symbolic link permissions are read-only; the target is never changed.' : stat.mode == null ? 'Permissions are not provided by this SFTP server' : type === 'unknown' ? 'The server does not provide a safe entry type; attributes are read-only.' : null,
    capabilities: { calculateSize: type === 'directory', changeMode: writable && stat.mode != null, changeOwner: writable && stat.uid != null && stat.gid != null, changeGroup: writable && stat.uid != null && stat.gid != null, preview: type === 'file' } }
}
export const sparseSftpUpdate = (stat, update) => {
  const result = {}
  if (!update || !Object.keys(update).length || Object.keys(update).some((key) => !['mode', 'uid', 'gid'].includes(key))) throw error('Invalid permissions update', 'EINVAL')
  if (!['file', 'directory'].includes(typeOf(stat.mode))) throw error('Permissions cannot be safely changed for this entry')
  if (update.mode != null) {
    if (!Number.isInteger(update.mode) || update.mode < 0 || update.mode > 0o7777) throw error('Invalid permission mode', 'EINVAL')
    result.mode = (stat.mode & ~0o777) | (update.mode & 0o777)
  }
  // SFTP v3 encodes UID/GID as one pair; keep the unchanged partner, never use 0.
  if (update.uid != null || update.gid != null) {
    if (stat.uid == null || stat.gid == null) throw error('Ownership is not provided by this SFTP server')
    for (const key of ['uid', 'gid']) {
      const value = update[key] ?? stat[key]
      if (!Number.isInteger(value) || value < 0 || value >= 0xffffffff) throw error('Invalid owner/group ID', 'EINVAL')
      result[key] = value
    }
  }
  return result
}
export const readLocalProperties = async (requested) => {
  const logical = resolveInsideRoot(requested)
  const physical = logical === fileManagerRoot || logical === path.parse(logical).root ? logical : path.join(await verifyRealPathInsideRoot(path.dirname(logical)), path.basename(logical))
  const stat = await fs.lstat(physical)
  const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
  return { name: path.basename(logical) || logical, path: logical, type, size: type === 'directory' ? null : stat.size,
    createdAt: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null, modifiedAt: stat.mtime.toISOString(), accessedAt: stat.atime.toISOString(),
    target: type === 'symlink' ? await fs.readlink(physical).catch(() => null) : null, permissions: null,
    permissionsMessage: 'Extended permissions are available in the native app.',
    capabilities: { calculateSize: desktopFilesystem && type === 'directory', changeMode: false, changeOwner: false, changeGroup: false, preview: type === 'file' } }
}
export const calculateMetadataSize = async ({ root, children, signal, onProgress }) => {
  const progress = { bytes: 0, items: 0, errors: 0, cancelled: false }, pending = [root]
  let last = 0
  while (pending.length && !signal.aborted) {
    let entries
    try { entries = await children(pending.pop()) } catch { progress.errors++; continue }
    for (const entry of entries) {
      if (signal.aborted) break
      progress.items++
      if (entry.type === 'directory') pending.push(entry.path)
      else if (['file', 'symlink'].includes(entry.type) && entry.size != null) progress.bytes += entry.size
      else progress.errors++
      if (Date.now() - last >= 100) { onProgress({ ...progress }); last = Date.now() }
    }
  }
  progress.cancelled = signal.aborted
  return progress
}
export const registerPropertiesHandlers = (socket, { ssh }) => {
  const jobs = new Map()
  const read = async (payload) => {
    if (!payload?.filesystemId || payload.filesystemId === 'local') return readLocalProperties(payload?.path)
    const connection = await ssh.ensure(payload.filesystemId), requested = connection.resolve(payload.path)
    const stat = await call(connection.sftp, 'lstat', requested)
    return remoteProperties(requested, stat, typeOf(stat.mode) === 'symlink' ? await call(connection.sftp, 'readlink', requested).catch(() => null) : null)
  }
  socket.on('filesystem:properties', async (payload, ack) => {
    try { ack?.({ ok: true, properties: await read(payload) }) }
    catch (e) { ack?.({ ok: false, error: serializeFilesystemError(e, payload?.path) }) }
  })
  socket.on('filesystem:update-properties', async (payload, ack) => {
    try {
      if (!payload?.filesystemId || payload.filesystemId === 'local') throw error('Extended permissions are available in the native app')
      const connection = await ssh.ensure(payload.filesystemId), requested = connection.resolve(payload.path)
      const stat = await call(connection.sftp, 'lstat', requested)
      await call(connection.sftp, 'setstat', requested, sparseSftpUpdate(stat, payload.update))
      ack?.({ ok: true, properties: await read(payload) })
    } catch (e) { ack?.({ ok: false, error: serializeFilesystemError(e, payload?.path) }) }
  })
  socket.on('filesystem:calculate-size', async (payload, ack) => {
    if (!payload?.jobId || jobs.has(payload.jobId)) { ack?.({ ok: false, error: { code: 'EINVAL', message: 'Invalid size job' } }); return }
    const controller = new AbortController(); jobs.set(payload.jobId, controller)
    ack?.({ ok: true })
    try {
      const properties = await read(payload)
      if (!properties.capabilities.calculateSize) throw error('Size calculation is unavailable for this entry')
      let children
      if (payload.filesystemId === 'local') {
        children = async (directory) => {
          const real = await verifyRealPathInsideRoot(directory)
          const stat = await fs.lstat(directory)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('This entry is no longer a directory')
          const entries = await fs.readdir(real)
          return Promise.all(entries.map(async (name) => {
            const entryPath = path.join(directory, name)
            try { const m = await fs.lstat(entryPath); return { path: entryPath, type: m.isSymbolicLink() ? 'symlink' : m.isDirectory() ? 'directory' : m.isFile() ? 'file' : 'other', size: m.size } }
            catch { return { path: entryPath, type: 'unknown' } }
          }))
        }
      } else {
        const connection = await ssh.ensure(payload.filesystemId)
        children = async (directory) => {
          const stat = await call(connection.sftp, 'lstat', connection.resolve(directory))
          if (typeOf(stat.mode) !== 'directory') throw error('This entry is no longer a directory')
          const entries = await call(connection.sftp, 'readdir', directory)
          return entries.filter((e) => !['.', '..'].includes(e.filename)).map((e) => ({ path: path.posix.join(directory, e.filename), type: e.filename && !e.filename.includes('/') ? typeOf(e.attrs?.mode) : 'unknown', size: e.attrs?.size }))
        }
      }
      const progress = await calculateMetadataSize({ root: payload.path, children, signal: controller.signal,
        onProgress: (progress) => socket.emit('filesystem:size-progress', { jobId: payload.jobId, progress, done: false }) })
      socket.emit('filesystem:size-progress', { jobId: payload.jobId, progress, done: true })
    } catch (e) { socket.emit('filesystem:size-progress', { jobId: payload.jobId, error: serializeFilesystemError(e, payload.path), done: true }) }
    finally { jobs.delete(payload.jobId) }
  })
  socket.on('filesystem:calculate-size-cancel', (payload, ack) => { jobs.get(payload?.jobId)?.abort(); ack?.({ ok: true }) })
  socket.on('disconnect', () => { for (const job of jobs.values()) job.abort(); jobs.clear() })
}
