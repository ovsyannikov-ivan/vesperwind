import { decodeTextPreview } from '../shared/textPreview.js'
import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import posix from 'node:path/posix'
import ssh2 from 'ssh2'
import { unsafeEntryName } from '../shared/entryName.js'

const { Client } = ssh2
const SSH_SESSION_FIELDS = ['protocol', 'host', 'port', 'username', 'authType', 'privateKeyPath', 'sshConfigHost', 'trustedFingerprint']
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const DIRECTORY_MODE = 0o040000
const SYMLINK_MODE = 0o120000

const remoteError = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })
const cancelled = () => remoteError('ECANCELLED', 'The operation was cancelled')
const profileChanged = () => remoteError('ESSH_PROFILE_CHANGED', 'The connection settings changed while connecting. Connect again to use the new settings.')
/** The error an aborted connect ends with (cancelled unless a reason was given). */
const abortReason = (signal) => (signal.reason?.code ? signal.reason : cancelled())
const call = (target, method, ...args) => new Promise((resolve, reject) => {
  target[method](...args, (error, ...values) => error ? reject(error) : resolve(values.length > 1 ? values : values[0]))
})
const providerConnectionId = (providerId) =>
  typeof providerId === 'string' && providerId.startsWith('sftp:') ? providerId.slice(5) : null
const fingerprint = (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
const hostIdentity = (profile) => `${profile.host}:${profile.port}`
export const remoteInitialPath = (profile) => profile?.initialPath || '/'

export const validateConnectionProfile = (profile) => {
  if (!profile || typeof profile !== 'object') throw remoteError('EINVAL', 'A connection profile is required')
  const port = Number.parseInt(profile.port, 10)
  if (!/^[A-Za-z0-9._-]+$/.test(profile.id || '')) throw remoteError('EINVAL', 'Invalid connection ID')
  // SSH handles SFTP profiles only; FTP/FTPS (or unknown) profiles are never SSH.
  if ((profile.protocol ?? 'sftp') !== 'sftp') throw remoteError('EINVAL', 'This connection profile is not an SFTP profile')
  if (!String(profile.name || '').trim()) throw remoteError('EINVAL', 'Connection name is required')
  if (!String(profile.host || '').trim() || /[\0\r\n]/.test(profile.host)) throw remoteError('EINVAL', 'Invalid SSH host')
  if (!String(profile.username || '').trim() || /[\0\r\n]/.test(profile.username)) throw remoteError('EINVAL', 'Invalid SSH username')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw remoteError('EINVAL', 'SSH port must be between 1 and 65535')
  if (!['auto', 'agent', 'password', 'privateKey'].includes(profile.authType)) throw remoteError('EINVAL', 'Unsupported authentication type')
  if (profile.authType === 'privateKey' && !String(profile.privateKeyPath || '').trim()) throw remoteError('EINVAL', 'Private key path is required')
  if (profile.initialPath && (!String(profile.initialPath).startsWith('/') || String(profile.initialPath).includes('\\'))) {
    throw remoteError('EINVAL', 'Remote paths must be absolute POSIX paths')
  }
  return { ...profile, port }
}

const serializeSshError = (error) => ({
  code: error?.code || (/authentication/i.test(error?.message || '') ? 'EAUTHENTICATION' : 'ESSH'),
  message: error?.message || 'The SSH operation failed',
  ...(error?.hostKey ? { hostKey: error.hostKey } : {}),
  ...(error?.partialResult ? { partialResult: error.partialResult } : {}),
  ...(error?.auth ? { auth: error.auth } : {}),
})

export const sessionAuthOptions = async (profile, input = '') => {
  const secrets = typeof input === 'string'
    ? { password: profile.authType === 'privateKey' ? '' : input, keyPassphrase: profile.authType === 'privateKey' ? input : '' }
    : { password: input?.password || '', keyPassphrase: input?.keyPassphrase || '' }
  if (profile.sshConfigHost) throw remoteError('ESSH_CONFIG_UNSUPPORTED', 'SSH config profiles require the native app in this runtime')
  const username = profile.username, attempts = [], methods = []
  let encrypted = false, interaction = false, promptRounds = 0
  const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : null)
  if (['auto', 'agent'].includes(profile.authType) && agent) methods.push({ type: 'agent', username, agent })
  if (profile.authType === 'agent' && !agent) throw remoteError('EAUTHENTICATION_REQUIRED', 'SSH Agent is unavailable', { auth: { needs: 'agent', attempted: [] } })
  if (['auto', 'privateKey'].includes(profile.authType)) {
    const paths = profile.authType === 'privateKey' ? [profile.privateKeyPath]
      : [profile.privateKeyPath, ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map(name => path.join(os.homedir(), '.ssh', name))]
    for (const raw of [...new Set(paths.filter(Boolean))]) {
      const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw
      let key
      try { key = await fsp.readFile(expanded) } catch (error) { if (profile.authType === 'privateKey') throw remoteError(error.code || 'EKEY', 'Unable to read the selected private key'); continue }
      const parsed = ssh2.utils.parseKey(key, secrets.keyPassphrase || undefined)
      if (parsed instanceof Error) { encrypted ||= /passphrase|encrypt/i.test(parsed.message); continue }
      methods.push({ type: 'publickey', username, key: parsed })
    }
  }
  if (['auto', 'password'].includes(profile.authType) && secrets.password) {
    methods.push({ type: 'password', username, password: secrets.password })
    methods.push({ type: 'keyboard-interactive', username, prompt: (_name, _instructions, _lang, prompts, finish) => {
      promptRounds++
      if (promptRounds === 1 && prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt) && !/otp|token|verification|one-time/i.test(prompts[0].prompt)) finish([secrets.password])
      else { interaction = true; finish(prompts.map(() => '')) }
    } })
  }
  const failure = () => ({ needs: interaction ? 'interaction' : profile.authType === 'agent' ? 'agent' : encrypted ? 'keyPassphrase' : profile.authType === 'privateKey' ? 'privateKey' : 'password', attempted: attempts })
  return { authHandler: () => {
    const method = methods.shift()
    if (!method) return false
    attempts.push(method.type === 'publickey' ? 'privateKey' : method.type)
    return method
  }, failure }
}

class RemoteConnection {
  constructor(profile, secret, socket, onClosed) {
    this.profile = profile
    this.secret = secret
    this.socket = socket
    this.onClosed = onClosed
    this.client = null
    this.sftp = null
    this.homePath = '/'
    this.rootPath = '/'
    this.initialPath = '/'
    this.status = 'connecting'
    this.terminals = new Map()
  }

  /** Connects; aborting `signal` closes the SSH connection at once and rejects. */
  async connect(signal) {
    if (signal?.aborted) throw abortReason(signal)
    const client = new Client()
    let verificationError = null
    let settled = false
    const auth = await sessionAuthOptions(this.profile, this.secret)
    if (signal?.aborted) throw abortReason(signal)
    const ready = new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => { if (!settled) reject(abortReason(signal)) }, { once: true })
      client.once('ready', () => {
        if (auth.failure().needs === 'interaction') {
          reject(remoteError('EAUTHENTICATION_REQUIRED', 'This server requires unsupported keyboard-interactive/MFA authentication', { auth: auth.failure() }))
          return
        }
        settled = true
        resolve()
      })
      // Kept for the life of the client: closing a cancelled handshake can
      // still report an error after the attempt has already failed.
      client.on('error', (error) => { if (!settled) reject(verificationError || error) })
    })
    const options = {
      host: this.profile.host,
      port: this.profile.port,
      username: this.profile.username,
      readyTimeout: 20_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        const observed = fingerprint(key)
        const hostKey = { host: hostIdentity(this.profile), fingerprint: observed }
        if (!this.profile.trustedFingerprint) {
          verificationError = remoteError('EHOSTKEY_UNKNOWN', 'Confirm this SSH host key before connecting', { hostKey })
          return false
        }
        if (this.profile.trustedFingerprint !== observed) {
          verificationError = remoteError('EHOSTKEY_CHANGED', 'REMOTE HOST IDENTIFICATION HAS CHANGED', {
            hostKey: { ...hostKey, previousFingerprint: this.profile.trustedFingerprint },
          })
          return false
        }
        return true
      },
    }
    options.authHandler = auth.authHandler
    client.connect(options)
    await ready.catch((error) => {
      client.end()
      if (signal?.aborted) throw abortReason(signal)
      if (!verificationError && /authentication/i.test(error.message || '')) {
        const details = auth.failure()
        throw remoteError('EAUTHENTICATION_REQUIRED', details.needs === 'keyPassphrase' ? 'A key passphrase is required' : details.needs === 'agent' ? 'No usable identities were found in SSH Agent' : details.needs === 'interaction' ? 'This server requires unsupported keyboard-interactive/MFA authentication' : 'SSH authentication required', { auth: details })
      }
      throw error
    })
    this.client = client
    const closeOnAbort = () => client.end()
    signal?.addEventListener('abort', closeOnAbort, { once: true })
    try {
      if (signal?.aborted) throw abortReason(signal)
      this.sftp = await call(client, 'sftp')
      this.homePath = await call(this.sftp, 'realpath', '.')
      this.rootPath = '/'
      this.initialPath = posix.normalize(remoteInitialPath(this.profile))
      const initialStats = await call(this.sftp, 'stat', this.initialPath)
      if (!initialStats.isDirectory()) throw remoteError('ENOTDIR', 'Initial remote path is not a folder')
      if (signal?.aborted) throw abortReason(signal)
    } catch (error) {
      client.end()
      throw signal?.aborted ? abortReason(signal) : error
    } finally {
      signal?.removeEventListener('abort', closeOnAbort)
    }
    this.status = 'connected'
    client.on('close', () => this.markDisconnected())
    client.on('end', () => this.markDisconnected())
    return this.rootEntry()
  }

  markDisconnected() {
    if (this.status === 'disconnected') return
    this.status = 'disconnected'
    for (const [id] of this.terminals) {
      this.socket.emit('terminal:exit', { id, exitCode: null, signal: 'disconnected', disconnected: true })
    }
    this.terminals.clear()
    this.socket.emit('ssh:status', { connectionId: this.profile.id, status: 'disconnected' })
    this.onClosed?.(this)
  }

  resolve(requested) {
    if (typeof requested !== 'string' || !requested.startsWith('/') || requested.includes('\\')) throw remoteError('EINVAL', 'Invalid remote path')
    const normalized = posix.normalize(requested)
    const root = posix.normalize(this.rootPath)
    if (normalized !== root && !normalized.startsWith(root.endsWith('/') ? root : `${root}/`)) throw remoteError('EOUTSIDE_ROOT', 'Path is outside this remote connection root')
    return normalized
  }

  rootEntry() {
    return {
      name: posix.basename(this.rootPath) || '/', path: this.rootPath, type: 'directory',
      isDirectory: true, isSymbolicLink: false, size: null, modifiedAt: null, metadataError: null,
    }
  }

  initialEntry() {
    return {
      name: posix.basename(this.initialPath) || '/', path: this.initialPath, type: 'directory',
      isDirectory: true, isSymbolicLink: false, size: null, modifiedAt: null, metadataError: null,
    }
  }

  async list(requested) {
    const directory = this.resolve(requested)
    const entries = await call(this.sftp, 'readdir', directory)
    return entries.map((entry) => {
      const mode = entry.attrs?.mode || 0
      const isDirectory = (mode & 0o170000) === DIRECTORY_MODE
      return {
        name: entry.filename,
        path: posix.join(directory, entry.filename),
        type: isDirectory ? 'directory' : 'file',
        isDirectory,
        isSymbolicLink: (mode & 0o170000) === SYMLINK_MODE,
        size: isDirectory ? null : entry.attrs?.size ?? null,
        modifiedAt: entry.attrs?.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null,
        metadataError: null,
      }
    }).sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDirectory ? -1 : 1)
  }

  async readText(requested, options = {}) {
    const remotePath = this.resolve(requested)
    const stats = await call(this.sftp, 'stat', remotePath)
    if (!stats.isFile()) throw remoteError('EISDIR', 'The requested path is not a file')
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
      ? Math.min(options.maxBytes, MAX_TEXT_BYTES) : MAX_TEXT_BYTES
    if (stats.size > maxBytes) throw remoteError('EFILE_TOO_LARGE', 'Text file exceeds the read limit')
    const stream = this.sftp.createReadStream(remotePath, { start: 0, end: maxBytes, highWaterMark: 64 * 1024 })
    const chunks = []
    let length = 0
    for await (const chunk of stream) {
      length += chunk.length
      if (length > maxBytes) { stream.destroy(); throw remoteError('EFILE_TOO_LARGE', 'Text file exceeds the read limit') }
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    return { content: options.strictText ? decodeTextPreview(bytes) : bytes.toString('utf8'), modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null }
  }

  async readBinary(requested) {
    const remotePath = this.resolve(requested)
    const stats = await call(this.sftp, 'stat', remotePath)
    if (!stats.isFile()) throw remoteError('EISDIR', 'The requested path is not a file')
    if (stats.size > 32 * 1024 * 1024) throw remoteError('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be opened')
    const bytes = await call(this.sftp, 'readFile', remotePath)
    return { base64: Buffer.from(bytes).toString('base64'), modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null }
  }

  async writeBinary(requested, base64) {
    if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw remoteError('EINVAL', 'Invalid binary contents')
    if (base64.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) throw remoteError('EFILE_TOO_LARGE', 'Files larger than 32 MB cannot be saved')
    const bytes = Buffer.from(base64, 'base64')
    const remotePath = this.resolve(requested)
    const stats = await call(this.sftp, 'stat', remotePath)
    if (!stats.isFile()) throw remoteError('EISDIR', 'The requested path is not a file')
    await call(this.sftp, 'writeFile', remotePath, bytes)
    const updated = await call(this.sftp, 'stat', remotePath)
    return { modifiedAt: updated.mtime ? new Date(updated.mtime * 1000).toISOString() : null }
  }

  async contentSource(requested) {
    const remotePath = this.resolve(requested)
    const stats = await call(this.sftp, 'stat', remotePath)

    if (!stats.isFile()) {
      throw remoteError('ENOTFILE', 'The requested path is not a file')
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw remoteError(
        'EOVERFLOW',
        'The remote file size cannot be represented safely by this runtime',
      )
    }

    return {
      path: remotePath,
      size: stats.size,
      createReadStream: ({ start, end } = {}) =>
        this.sftp.createReadStream(remotePath, {
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
        }),
    }
  }

  async writeText(requested, content) {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw remoteError('EFILE_TOO_LARGE', 'Files larger than 10 MB cannot be opened in the editor')
    const remotePath = this.resolve(requested)
    await call(this.sftp, 'writeFile', remotePath, content, { encoding: 'utf8' })
    const stats = await call(this.sftp, 'stat', remotePath)
    return { modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null }
  }

  async remove(remotePath, { signal } = {}) {
    if (signal?.aborted) throw remoteError('ECANCELLED', 'The operation was cancelled')
    remotePath = this.resolve(remotePath)
    const stats = await call(this.sftp, 'lstat', remotePath)
    if (stats.isDirectory()) {
      // The whole listing is checked before anything is deleted.
      for (const name of await this.childNames(remotePath)) await this.remove(posix.join(remotePath, name), { signal })
      await call(this.sftp, 'rmdir', remotePath)
    } else await call(this.sftp, 'unlink', remotePath)
  }

  // Common provider endpoint (see remoteProviders.js), used for transfers
  // between any two providers.

  async stat(requested) {
    const remotePath = this.resolve(requested)
    try {
      const stats = await call(this.sftp, 'lstat', remotePath)
      return { name: posix.basename(remotePath), isDirectory: stats.isDirectory(), isSymbolicLink: stats.isSymbolicLink(), size: stats.size, modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null }
    } catch (error) {
      if (error?.code === 2) return null
      throw error
    }
  }

  /** Child names of a directory; a listing with an unsafe name is refused as a whole. */
  async childNames(requested) {
    const directory = this.resolve(requested)
    const names = (await call(this.sftp, 'readdir', directory)).map((entry) => entry.filename).filter((name) => name !== '.' && name !== '..')
    if (names.some(unsafeEntryName)) throw remoteError('EUNSAFE_NAME', 'The server listed an unsafe file name; the operation was stopped', { path: directory })
    return names
  }

  openRead(requested) {
    const stream = this.sftp.createReadStream(this.resolve(requested))
    const finish = new Promise((resolve, reject) => { stream.once('error', reject); stream.once('close', resolve) })
    finish.catch(() => {})
    return { stream, finish: () => finish }
  }

  async createNew(requested) {
    const stream = this.sftp.createWriteStream(this.resolve(requested), { flags: 'wx' })
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject) })
    const closed = new Promise((resolve, reject) => { stream.once('error', reject); stream.once('close', resolve) })
    closed.catch(() => {})
    return {
      stream,
      finish: async () => { if (!stream.writableEnded) stream.end(); await closed },
      abort: () => stream.destroy(),
    }
  }

  async createFolder(requested) { await call(this.sftp, 'mkdir', this.resolve(requested)) }

  async createEmptyFile(requested) { await call(this.sftp, 'writeFile', this.resolve(requested), Buffer.alloc(0), { flag: 'wx' }) }

  async rename(from, to) { await call(this.sftp, 'rename', this.resolve(from), this.resolve(to)) }

  async openTerminal(id, cols, rows) {
    const channel = await call(this.client, 'shell', { term: 'xterm-256color', cols, rows })
    this.terminals.set(id, channel)
    channel.on('data', (data) => this.socket.emit('terminal:output', { id, data: data.toString('utf8') }))
    channel.stderr?.on('data', (data) => this.socket.emit('terminal:output', { id, data: data.toString('utf8') }))
    channel.on('close', () => {
      this.terminals.delete(id)
      this.socket.emit('terminal:exit', { id, exitCode: channel.exitCode ?? 0, signal: channel.exitSignal })
    })
  }
}

const ATTEMPT_ID = /^[A-Za-z0-9-]{1,80}$/
// A finished attempt stays cancellable this long, so a cancel that crosses
// the successful answer still closes the connection the UI never opened.
const FINISHED_ATTEMPT_GRACE = 30_000
// Attempts are shared by every manager (one per socket) of one connection map.
const attemptState = new WeakMap()
const attemptsOf = (connections) => {
  if (!attemptState.has(connections)) attemptState.set(connections, { pending: new Map(), byId: new Map() })
  return attemptState.get(connections)
}

export class SshConnectionManager {
  constructor(socket, connections = new Map()) {
    this.socket = socket
    this.connections = connections
    const { pending, byId } = attemptsOf(connections)
    // The newest attempt per profile id; an older one is aborted when a newer starts.
    this.pending = pending
    // Attempts by the id the client chose, for `cancel`.
    this.attempts = byId
  }
  get(providerId) {
    const id = providerConnectionId(providerId)
    const connection = id && this.connections.get(id)
    if (!connection || connection.status !== 'connected') throw remoteError('ESSH_DISCONNECTED', 'The remote connection is disconnected')
    return connection
  }
  async ensure(providerId) {
    const id = providerConnectionId(providerId)
    const existing = id && this.connections.get(id)
    if (existing?.status === 'disconnected') await this.reconnect(existing)
    return this.get(providerId)
  }
  /** Reconnects a lost connection, joining an attempt already running for it instead of superseding it. */
  async reconnect(existing) {
    const running = this.pending.get(existing.profile.id)
    if (running) await running.done
    else await this.connect(existing.profile, existing.secret)
  }
  /**
   * Only the newest attempt for a profile registers: a newer connect, a
   * `cancel`, a disconnect or a saved settings change aborts an attempt that
   * is still connecting, so a late answer never replaces a newer session.
   */
  async connect(profileValue, secret = '', { attemptId } = {}) {
    const profile = validateConnectionProfile(profileValue)
    if (attemptId !== undefined && (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId) || this.attempts.has(attemptId))) {
      throw remoteError('EINVAL', 'Invalid connection attempt ID')
    }
    let finished
    const attempt = { id: attemptId, profileId: profile.id, controller: new AbortController(), connection: null, done: new Promise((resolve) => { finished = resolve }) }
    this.pending.get(profile.id)?.controller.abort(cancelled())
    this.pending.set(profile.id, attempt)
    if (attemptId) this.attempts.set(attemptId, attempt)
    this.connections.get(profile.id)?.client?.end()
    try {
      const connection = new RemoteConnection(profile, secret, this.socket)
      const root = await connection.connect(attempt.controller.signal)
      attempt.connection = connection
      this.connections.set(profile.id, connection)
      this.socket?.emit('ssh:status', { connectionId: profile.id, status: 'connected' })
      return { connectionId: profile.id, providerId: `sftp:${profile.id}`, status: 'connected', root, initial: connection.initialEntry(), homePath: connection.homePath }
    } finally {
      finished()
      if (this.pending.get(profile.id) === attempt) this.pending.delete(profile.id)
      if (attemptId) {
        if (attempt.connection) setTimeout(() => this.attempts.delete(attemptId), FINISHED_ATTEMPT_GRACE).unref?.()
        else this.attempts.delete(attemptId)
      }
    }
  }
  /**
   * Cancels the attempt `attemptId`: a running one is aborted; one that
   * already connected is closed while it is still its profile's connection.
   */
  cancel(attemptId) {
    const attempt = typeof attemptId === 'string' ? this.attempts.get(attemptId) : undefined
    if (!attempt) return false
    this.attempts.delete(attemptId)
    if (!attempt.connection) {
      attempt.controller.abort(cancelled())
      return true
    }
    if (this.connections.get(attempt.profileId) !== attempt.connection) return false
    // Not `disconnect`: a newer attempt for this profile keeps running.
    attempt.connection.client?.end()
    this.connections.delete(attempt.profileId)
    return true
  }
  /** Ends the connection and any attempt for `id`. */
  disconnect(id) {
    this.pending.get(id)?.controller.abort(cancelled())
    const connection = this.connections.get(id); connection?.client?.end(); this.connections.delete(id)
  }
  /**
   * After settings were saved: a session whose saved profile was removed or
   * changed endpoint, protocol, identity, authentication or host key trust
   * is closed, so the next connect uses (and confirms) the new settings.
   */
  invalidate(previousProfiles, nextProfiles) {
    const before = new Map((Array.isArray(previousProfiles) ? previousProfiles : []).map((profile) => [profile.id, profile]))
    const after = new Map((Array.isArray(nextProfiles) ? nextProfiles : []).map((profile) => [profile.id, profile]))
    const changed = (id) => {
      const old = before.get(id)
      if (!old) return false
      const next = after.get(id)
      return !next || SSH_SESSION_FIELDS.some((field) => (next[field] ?? null) !== (old[field] ?? null))
    }
    // An attempt still connecting with the old settings stops as well.
    for (const [id, attempt] of [...this.pending]) {
      if (changed(id)) attempt.controller.abort(profileChanged())
    }
    for (const id of [...this.connections.keys()]) {
      if (changed(id)) {
        this.connections.get(id)?.markDisconnected?.()
        this.disconnect(id)
      }
    }
  }
  shutdown() {
    for (const attempt of [...this.pending.values()]) attempt.controller.abort(cancelled())
    for (const connection of this.connections.values()) connection.client?.end()
    this.connections.clear()
  }

  async createTerminal({ connectionId, cols, rows }) {
    let connection = this.connections.get(connectionId)
    if (connection?.status === 'disconnected') {
      await this.reconnect(connection)
      connection = this.connections.get(connectionId)
    }
    if (!connection || connection.status !== 'connected') throw remoteError('ESSH_DISCONNECTED', 'Connect to this remote host before opening a terminal')
    const id = randomUUID()
    await connection.openTerminal(id, cols, rows)
    return { id, title: `${connection.profile.username}@${connection.profile.host}` }
  }
  writeTerminal(id, data) { for (const connection of this.connections.values()) connection.terminals.get(id)?.write(data) }
  resizeTerminal(id, cols, rows) { for (const connection of this.connections.values()) connection.terminals.get(id)?.setWindow(rows, cols, 0, 0) }
  closeTerminal(id) { for (const connection of this.connections.values()) { const channel = connection.terminals.get(id); if (channel) { channel.end(); connection.terminals.delete(id) } } }
}

export const registerSshHandlers = (socket, { connections } = {}) => {
  const manager = new SshConnectionManager(socket, connections)
  socket.on('ssh:connect', async (payload, acknowledge) => {
    try { acknowledge?.({ ok: true, ...(await manager.connect(payload?.profile, payload?.secrets || payload?.secret, { attemptId: payload?.attemptId })) }) }
    catch (error) { acknowledge?.({ ok: false, error: serializeSshError(error), hostKey: error?.hostKey, auth: error?.auth }) }
  })
  // Cancels one `ssh:connect` by the attemptId it was sent with.
  socket.on('ssh:cancel-connect', (payload, acknowledge) => acknowledge?.({ ok: true, cancelled: manager.cancel(payload?.attemptId) }))
  socket.on('ssh:disconnect', (payload, acknowledge) => { manager.disconnect(payload?.connectionId); acknowledge?.({ ok: true }) })
  socket.on('ssh:status', (payload, acknowledge) => {
    const connection = manager.connections.get(payload?.connectionId)
    acknowledge?.({ ok: true, status: connection?.status || 'disconnected' })
  })
  for (const event of ['ssh:config-hosts', 'ssh:config-resolve']) {
    socket.on(event, (_payload, acknowledge) => acknowledge?.({ ok: false, error: { code: 'ESSH_CONFIG_UNSUPPORTED', message: 'SSH config discovery is available in the native app' } }))
  }
  socket.on('disconnect', () => manager.shutdown())
  return manager
}

export { providerConnectionId, serializeSshError }
