import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isSea } from 'node:sea'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'
import { SQLITE_LIMITS, validateSqliteRequest } from '../shared/sqlitePolicy.js'

const failure = (code, message) => ({ ok: false, error: { code, message } })
export const createSqliteSessions = ({ resolve = resolveInsideRoot, verify = verifyRealPathInsideRoot } = {}) => {
  const sessions = new Map()
  const close = id => {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    session.child.kill('SIGKILL') // SQLite rolls back any uncommitted transaction.
    session.pending?.(failure('ECANCELLED', 'Query stopped; uncommitted changes were rolled back. Reopen this database.'))
  }
  const send = (session, request) => new Promise(resolve => {
    if (session.pending) { resolve(failure('ESQLITE_BUSY', 'A query is already running')); return }
    const timer = setTimeout(() => close(session.id), SQLITE_LIMITS.timeoutMs)
    session.pending = response => { clearTimeout(timer); session.pending = null; resolve(response) }
    session.child.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) close(session.id) })
  })
  return {
    async open(request) {
      if (validateSqliteRequest({ ...request, action: 'schema' })) return failure('EINVAL', 'Invalid database session')
      if (request.filesystemId && request.filesystemId !== 'local') return failure('ENOTSUPPORTED', 'SQLite editing currently supports local files, mounted disks and shares')
      if (sessions.has(request.sessionId) || sessions.size >= 16) return failure('ESQLITE_BUSY', 'Too many open databases or a duplicate session')
      let path
      try { path = await verify(resolve(request.path)) } catch (error) { return failure(error.code || 'ESQLITE', error.message) }
      if (sessions.has(request.sessionId) || sessions.size >= 16) return failure('ESQLITE_BUSY', 'Too many open databases or a duplicate session')
      const args = isSea() ? [] : [typeof __dirname === 'string' ? path.join(__dirname, 'app.cjs') : fileURLToPath(new URL('./index.js', import.meta.url))]
      const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, VESPERWIND_SQLITE_WORKER: '1' } })
      const session = { id: request.sessionId, child, pending: null }
      sessions.set(session.id, session)
      createInterface({ input: child.stdout }).on('line', line => {
        try { session.pending?.(JSON.parse(line)) } catch { close(session.id) }
      })
      let nativeError = ''
      child.stderr.on('data', chunk => { nativeError = (nativeError + chunk).slice(-2048) })
      child.on('error', error => { session.pending?.(failure(error.code || 'ESQLITE', error.message)); close(session.id) })
      child.on('exit', () => { session.pending?.(failure('ESQLITE_CLOSED', nativeError || 'The database session ended. Reopen this database.')); close(session.id) })
      const result = await send(session, { action: 'open', path })
      if (!result.ok) close(session.id)
      return result
    },
    request(request) {
      const invalid = validateSqliteRequest(request)
      if (invalid) return Promise.resolve(failure('EINVAL', invalid))
      const session = sessions.get(request.sessionId)
      return session ? send(session, request) : Promise.resolve(failure('ESQLITE_CLOSED', 'The database session ended. Reopen this database.'))
    },
    close,
    dispose() { for (const id of sessions.keys()) close(id) },
  }
}
export const registerSqliteHandlers = socket => {
  const sessions = createSqliteSessions()
  socket.on('sqlite:open', async (request, acknowledge) => acknowledge?.(await sessions.open(request)))
  socket.on('sqlite:request', async (request, acknowledge) => acknowledge?.(await sessions.request(request)))
  socket.on('sqlite:close', (request, acknowledge) => { sessions.close(request?.sessionId); acknowledge?.({ ok: true }) })
  socket.on('sqlite:cancel', (request, acknowledge) => { sessions.close(request?.sessionId); acknowledge?.({ ok: true }) })
  socket.on('disconnect', () => sessions.dispose())
}
