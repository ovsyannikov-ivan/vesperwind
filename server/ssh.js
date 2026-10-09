import { decodeTextPreview } from '../shared/textPreview.js'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import posix from 'node:path/posix'
import { pipeline } from 'node:stream/promises'
import ssh2 from 'ssh2'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'
import { entryNameError } from '../shared/entryName.js'

const { Client } = ssh2
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const DIRECTORY_MODE = 0o040000
const SYMLINK_MODE = 0o120000

const remoteError = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })
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

  async connect() {
    const client = new Client()
    let verificationError = null
    let settled = false
    const auth = await sessionAuthOptions(this.profile, this.secret)
    const ready = new Promise((resolve, reject) => {
      client.once('ready', () => {
        if (auth.failure().needs === 'interaction') {
          reject(remoteError('EAUTHENTICATION_REQUIRED', 'This server requires unsupported keyboard-interactive/MFA authentication', { auth: auth.failure() }))
          return
        }
        settled = true
        resolve()
      })
      client.once('error', (error) => { if (!settled) reject(verificationError || error) })
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
      if (!verificationError && /authentication/i.test(error.message || '')) {
        const details = auth.failure()
        throw remoteError('EAUTHENTICATION_REQUIRED', details.needs === 'keyPassphrase' ? 'A key passphrase is required' : details.needs === 'agent' ? 'No usable identities were found in SSH Agent' : details.needs === 'interaction' ? 'This server requires unsupported keyboard-interactive/MFA authentication' : 'SSH authentication required', { auth: details })
      }
      throw error
    })
    this.client = client
    this.sftp = await call(client, 'sftp')
    this.homePath = await call(this.sftp, 'realpath', '.')
    this.rootPath = '/'
    this.initialPath = posix.normalize(remoteInitialPath(this.profile))
    const initialStats = await call(this.sftp, 'stat', this.initialPath)
    if (!initialStats.isDirectory()) throw remoteError('ENOTDIR', 'Initial remote path is not a folder')
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

  async remove(remotePath) {
    remotePath = this.resolve(remotePath)
    const stats = await call(this.sftp, 'lstat', remotePath)
    if (stats.isDirectory()) {
      for (const entry of await call(this.sftp, 'readdir', remotePath)) await this.remove(posix.join(remotePath, entry.filename))
      await call(this.sftp, 'rmdir', remotePath)
    } else await call(this.sftp, 'unlink', remotePath)
  }

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

export class SshConnectionManager {
  constructor(socket, connections = new Map()) { this.socket = socket; this.connections = connections }
  get(providerId) {
    const id = providerConnectionId(providerId)
    const connection = id && this.connections.get(id)
    if (!connection || connection.status !== 'connected') throw remoteError('ESSH_DISCONNECTED', 'The remote connection is disconnected')
    return connection
  }
  async ensure(providerId) {
    const id = providerConnectionId(providerId)
    const existing = id && this.connections.get(id)
    if (existing?.status === 'disconnected') await this.connect(existing.profile, existing.secret)
    return this.get(providerId)
  }
  async connect(profileValue, secret = '') {
    const profile = validateConnectionProfile(profileValue)
    this.connections.get(profile.id)?.client?.end()
    const connection = new RemoteConnection(profile, secret, this.socket)
    const root = await connection.connect()
    this.connections.set(profile.id, connection)
    this.socket.emit('ssh:status', { connectionId: profile.id, status: 'connected' })
    return { connectionId: profile.id, providerId: `sftp:${profile.id}`, status: 'connected', root, initial: connection.initialEntry(), homePath: connection.homePath }
  }
  disconnect(id) { const connection = this.connections.get(id); connection?.client?.end(); this.connections.delete(id) }
  shutdown() { for (const connection of this.connections.values()) connection.client?.end(); this.connections.clear() }

  async operate(payload) {
    const sourceRemote = providerConnectionId(payload.filesystemId)
    const targetRemote = providerConnectionId(payload.targetFilesystemId)
    const action = payload.action
    if (['create-file', 'create-folder'].includes(action)) {
      const invalidName = entryNameError(payload.name)
      if (invalidName) throw remoteError('EINVALID_NAME', invalidName)
      const target = this.get(payload.targetFilesystemId)
      const destination = target.resolve(posix.join(payload.targetDirectory, payload.name))
      if (action === 'create-folder') await call(target.sftp, 'mkdir', destination)
      else await call(target.sftp, 'writeFile', destination, Buffer.alloc(0), { flag: 'wx' })
      return { action, sourcePath: null, targetDirectory: payload.targetDirectory, destinationPath: destination }
    }
    const sourceConnection = sourceRemote ? this.get(payload.filesystemId) : null
    if (action === 'delete') {
      await sourceConnection.remove(payload.sourcePath)
      return { action, sourcePath: payload.sourcePath, targetDirectory: null, destinationPath: null }
    }
    if (action === 'rename') {
      const invalidName = entryNameError(payload.name)
      if (invalidName) throw remoteError('EINVALID_NAME', invalidName)
      const source = sourceConnection.resolve(payload.sourcePath)
      const destination = sourceConnection.resolve(posix.join(posix.dirname(source), payload.name))
      await call(sourceConnection.sftp, 'rename', source, destination)
      return { action, sourcePath: source, targetDirectory: posix.dirname(source), destinationPath: destination }
    }
    if (action === 'link') throw remoteError('ENOTSUPPORTED', 'Symbolic links are not available for cross-provider operations')
    const targetConnection = targetRemote ? this.get(payload.targetFilesystemId) : null
    const sourceName = sourceRemote ? posix.basename(payload.sourcePath) : path.basename(payload.sourcePath)
    const destination = targetRemote
      ? targetConnection.resolve(posix.join(payload.targetDirectory, sourceName))
      : resolveInsideRoot(path.join(await verifyRealPathInsideRoot(resolveInsideRoot(payload.targetDirectory)), sourceName))
    if (sourceRemote && targetRemote && sourceRemote === targetRemote) {
      const resolvedSource = sourceConnection.resolve(payload.sourcePath)
      if (resolvedSource === destination) throw remoteError('ESAMEPATH', 'The item is already in this folder')
      const sourceStats = await call(sourceConnection.sftp, 'lstat', resolvedSource)
      if (sourceStats.isDirectory() && destination.startsWith(`${resolvedSource.replace(/\/$/, '')}/`)) {
        throw remoteError('ECYCLE', 'A folder cannot be copied or moved into itself')
      }
    }
    if (action === 'move' && sourceRemote && targetRemote && sourceRemote === targetRemote) {
      await call(sourceConnection.sftp, 'rename', sourceConnection.resolve(payload.sourcePath), destination)
    } else {
      await this.copy(sourceConnection, payload.sourcePath, targetConnection, destination)
      if (action === 'move') {
        try {
          if (sourceRemote) await sourceConnection.remove(payload.sourcePath)
          else await fsp.rm(await verifyRealPathInsideRoot(resolveInsideRoot(payload.sourcePath)), { recursive: true })
        } catch (error) {
          throw remoteError('EPARTIAL_MOVE', 'The copy completed, but the source could not be removed', { partialResult: { destinationPath: destination } })
        }
      }
    }
    return { action, sourcePath: payload.sourcePath, targetDirectory: payload.targetDirectory, destinationPath: destination }
  }

  async copy(sourceConnection, sourcePath, targetConnection, destination) {
    const resolvedSource = sourceConnection
      ? sourceConnection.resolve(sourcePath)
      : await verifyRealPathInsideRoot(resolveInsideRoot(sourcePath))
    const sourceStats = sourceConnection
      ? await call(sourceConnection.sftp, 'lstat', resolvedSource)
      : await fsp.lstat(resolvedSource)
    if (sourceStats.isDirectory()) {
      if (targetConnection) await call(targetConnection.sftp, 'mkdir', destination)
      else await fsp.mkdir(destination)
      const children = sourceConnection
        ? await call(sourceConnection.sftp, 'readdir', resolvedSource)
        : await fsp.readdir(resolvedSource, { withFileTypes: true })
      for (const child of children) {
        const name = sourceConnection ? child.filename : child.name
        await this.copy(sourceConnection, sourceConnection ? posix.join(resolvedSource, name) : path.join(resolvedSource, name), targetConnection, targetConnection ? posix.join(destination, name) : path.join(destination, name))
      }
      return
    }
    const reader = sourceConnection
      ? sourceConnection.sftp.createReadStream(resolvedSource)
      : fs.createReadStream(resolvedSource)
    const writer = targetConnection ? targetConnection.sftp.createWriteStream(destination, { flags: 'wx' }) : fs.createWriteStream(destination, { flags: 'wx' })
    await pipeline(reader, writer)
  }

  async createTerminal({ connectionId, cols, rows }) {
    let connection = this.connections.get(connectionId)
    if (connection?.status === 'disconnected') {
      await this.connect(connection.profile, connection.secret)
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
    try { acknowledge?.({ ok: true, ...(await manager.connect(payload?.profile, payload?.secrets || payload?.secret)) }) }
    catch (error) { acknowledge?.({ ok: false, error: serializeSshError(error), hostKey: error?.hostKey, auth: error?.auth }) }
  })
  socket.on('ssh:disconnect', (payload, acknowledge) => { manager.disconnect(payload?.connectionId); acknowledge?.({ ok: true }) })
  socket.on('ssh:status', (payload, acknowledge) => {
    const connection = manager.connections.get(payload?.connectionId)
    acknowledge?.({ ok: true, status: connection?.status || 'disconnected' })
  })
  socket.on('connections:capabilities', (_payload, acknowledge) => acknowledge?.({ ok: true, capabilities: { credentialStore: false, sshConfig: false, auto: true, agent: true } }))
  for (const event of ['connections:credential-status', 'connections:forget-credential']) {
    socket.on(event, (_payload, acknowledge) => acknowledge?.({ ok: false, error: { code: 'ECREDENTIAL_UNAVAILABLE', message: 'Secure credential storage is available in the native app' } }))
  }
  for (const event of ['ssh:config-hosts', 'ssh:config-resolve']) {
    socket.on(event, (_payload, acknowledge) => acknowledge?.({ ok: false, error: { code: 'ESSH_CONFIG_UNSUPPORTED', message: 'SSH config discovery is available in the native app' } }))
  }
  socket.on('disconnect', () => manager.shutdown())
  return manager
}

export const openSftpContentSource = async (connections, providerId, requestedPath) => {
  const id = providerConnectionId(providerId)
  const connection = id && connections?.get(id)

  if (!connection || connection.status !== 'connected') {
    throw remoteError('ESSH_DISCONNECTED', 'The remote connection is disconnected')
  }

  return connection.contentSource(requestedPath)
}

export { providerConnectionId, serializeSshError }
