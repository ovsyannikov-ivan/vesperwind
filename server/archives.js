import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { validateArchiveRequest } from '../shared/archivePolicy.js'
import { compatibleArchiveWorker } from '../shared/archiveWorkerPolicy.js'
import { resolveInsideRoot, verifyRealPathInsideRoot, serializeFilesystemError } from './filesystem.js'

const triples = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' }
export const bundledArchiveWorker = () => {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  if (process.env.VESPERWIND_ARCHIVE_ASSETS_DIR) return path.join(process.env.VESPERWIND_ARCHIVE_ASSETS_DIR, `vesperwind-archive${suffix}`)
  const directory = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(directory, '../src-tauri/binaries', `vesperwind-archive-${triples[`${process.platform}-${process.arch}`]}${suffix}`)
}
const cancelled = () => Object.assign(new Error('Archive operation cancelled'), { code: 'ECANCELLED' })
export const runWorker = (binary, args, { cwd, signal, onProgress = () => {} } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(cancelled()); return }
  const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let nativeError = '', failure = null, version = ''
  const abort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', abort, { once: true })
  const reader = createInterface({ input: child.stdout })
  reader.on('line', (line) => {
    if (args[0] === '--version') { version = line; return }
    try {
      const event = JSON.parse(line)
      if (event.error) failure = event.error
      else if (!signal?.aborted && !event.done) onProgress(event)
    } catch { failure = { code: 'EARCHIVE_PROTOCOL', message: 'Invalid archive worker response' }; abort() }
  })
  child.stderr.on('data', (value) => { nativeError = (nativeError + value).slice(-8192) })
  child.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(Object.assign(error, { code: error.code === 'ENOENT' ? 'EARCHIVE_SIDECAR' : error.code })) })
  child.on('close', (code) => {
    signal?.removeEventListener('abort', abort)
    if (signal?.aborted) reject(cancelled())
    else if (failure || code !== 0) reject(Object.assign(new Error(failure?.message || 'Archive worker failed'), { code: failure?.code || 'EARCHIVE_WORKER', nativeError }))
    else resolve(version)
  })
})
export const performArchive = async (request, { signal, onProgress, binary = bundledArchiveWorker() } = {}) => {
  const invalid = validateArchiveRequest(request)
  if (invalid) throw Object.assign(new Error(invalid.message), invalid)
  const logicalTarget = resolveInsideRoot(request.target.path)
  const target = await verifyRealPathInsideRoot(logicalTarget)
  if (!(await fs.stat(target)).isDirectory()) throw Object.assign(new Error('Choose a destination folder'), { code: 'ENOTDIR' })
  const sources = []
  for (const source of request.sources) {
    const logical = resolveInsideRoot(source.path)
    const stats = await fs.lstat(logical)
    if (stats.isSymbolicLink()) throw Object.assign(new Error('Archive sources cannot be links'), { code: 'EARCHIVE_UNSAFE_ENTRY' })
    sources.push(await verifyRealPathInsideRoot(logical))
  }
  if (sources.some((source) => target === source || target.startsWith(`${source}${path.sep}`))) {
    throw Object.assign(new Error('Archive destination cannot be inside a selected source folder'), { code: 'ECYCLE' })
  }
  if (signal?.aborted) throw cancelled()
  const names = sources.map((source) => path.basename(source).toLocaleLowerCase('en-US'))
  if (new Set(names).size !== names.length) throw Object.assign(new Error('Selected sources have duplicate names; archive them separately'), { code: 'EARCHIVE_DUPLICATE' })
  const version = await runWorker(binary, ['--version'], { signal })
  if (!compatibleArchiveWorker(version)) throw Object.assign(new Error('Bundled archive worker version or codec capabilities mismatch'), { code: 'EARCHIVE_VERSION' })
  const stage = await fs.mkdtemp(path.join(target, '.vesperwind-archive-'))
  try {
    await fs.chmod(stage, 0o700)
    const output = request.action === 'create' ? path.join(stage, 'output.zip') : stage
    await runWorker(binary, request.action === 'create' ? ['create', output, ...sources] : ['extract', sources[0]], { cwd: stage, signal, onProgress })
    if (signal?.aborted) throw cancelled()
    try { await runWorker(binary, ['publish', output, path.join(target, request.name)], { signal }) }
    catch (error) {
      // Atomic rename is the commit point. A cancellation arriving after the
      // rename must report the completed result, rather than a false rollback.
      const stillStaged = await fs.lstat(output).then(() => true, (e) => e.code !== 'ENOENT')
      if (stillStaged) throw error
    }
    return { action: request.action, targetDirectory: logicalTarget, destinationPath: path.join(logicalTarget, request.name) }
  } finally {
    try { await fs.rm(stage, { recursive: true, force: true }) }
    catch (error) { throw Object.assign(new Error('Unable to clean up archive staging folder'), { code: 'EARCHIVE_CLEANUP', path: stage, nativeError: error.message }) }
  }
}
export const registerArchiveHandlers = (socket) => {
  const jobs = new Map()
  socket.on('archive:start', (request, acknowledge) => {
    const invalid = validateArchiveRequest(request)
    if (invalid || typeof request?.jobId !== 'string' || !request.jobId || request.jobId.length > 128 || jobs.size) {
      acknowledge?.({ ok: false, error: invalid || { code: 'EARCHIVE_BUSY', message: 'An archive operation is already running or the request is invalid' } }); return
    }
    const controller = new AbortController(); jobs.set(request.jobId, controller)
    acknowledge?.({ ok: true, jobId: request.jobId })
    setImmediate(async () => {
      try {
        const result = await performArchive(request, { signal: controller.signal,
          onProgress: (event) => socket.emit('archive:progress', { jobId: request.jobId, ...event }) })
        socket.emit('archive:progress', { jobId: request.jobId, done: true, result })
      } catch (error) { socket.emit('archive:progress', { jobId: request.jobId, done: true, error: { ...serializeFilesystemError(error), nativeError: error.nativeError } }) }
      finally { jobs.delete(request.jobId) }
    })
  })
  socket.on('archive:cancel', ({ jobId } = {}, acknowledge) => { jobs.get(jobId)?.abort(); acknowledge?.({ ok: true }) })
  socket.on('disconnect', () => { for (const job of jobs.values()) job.abort() })
}
