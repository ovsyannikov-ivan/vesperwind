// One dispatch for every provider of the Node/SEA runtime: `local`,
// `sftp:<id>` (SshConnectionManager) and `ftp:<id>` / `ftps:<id>`
// (FtpConnectionManager). Handlers ask this module for a connection instead
// of assuming SFTP; an unknown provider is `EFILESYSTEM_ID`. File operations
// between any two providers follow the native `remote_ops::operate`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import posix from 'node:path/posix'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'
import { entryNameError, unsafeEntryName } from '../shared/entryName.js'

const providerError = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details })
const unavailable = () => providerError('EFILESYSTEM_ID', 'This filesystem is not available')
const PROFILE_ID = /^[A-Za-z0-9._-]{1,80}$/

/** `local`, `sftp`, `ftp` (also for `ftps:`), or throws EFILESYSTEM_ID. */
export const providerKind = (providerId) => {
  if (providerId === undefined || providerId === null || providerId === 'local') return 'local'
  if (typeof providerId !== 'string') throw unavailable()
  const separator = providerId.indexOf(':')
  const scheme = providerId.slice(0, separator), id = providerId.slice(separator + 1)
  if (separator <= 0 || !PROFILE_ID.test(id)) throw unavailable()
  if (scheme === 'sftp') return 'sftp'
  if (scheme === 'ftp' || scheme === 'ftps') return 'ftp'
  throw unavailable()
}

const unsafeName = (directory) => providerError('EUNSAFE_NAME', 'The server listed an unsafe file name; the operation was stopped', { path: directory })

/**
 * The local path of one child of `directory`. Beyond the remote name rules it
 * applies the local platform's (on Windows: drive and stream separators,
 * reserved characters, trailing dots and spaces) and checks that the result
 * is a direct child of `directory`, like the native `local_child`.
 */
export const localChild = (directory, name, platform = process.platform) => {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const invalid = unsafeEntryName(name) || name.includes('\0')
    || (platform === 'win32' && (/[<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)))
  const child = invalid ? null : paths.join(directory, name)
  if (!child || paths.relative(directory, child) !== name) {
    throw providerError('EUNSAFE_NAME', `“${String(name).slice(0, 200)}” cannot be used as a local file name`)
  }
  return child
}

const validateName = (name) => {
  const message = entryNameError(name)
  if (message) throw providerError('EINVALID_NAME', message)
}

const checkCancelled = (signal) => {
  if (signal?.aborted) throw providerError('ECANCELLED', 'The operation was cancelled')
}

/** Local side of a copy, with the same shape as a remote endpoint. */
const localEndpoint = {
  async isDirectory(resolved) { return (await fsp.lstat(resolved)).isDirectory() },
  async childNames(resolved) { return fsp.readdir(resolved) },
  openRead(resolved) {
    const stream = fs.createReadStream(resolved)
    return { stream, finish: async () => {} }
  },
  async createNew(destination) {
    const stream = fs.createWriteStream(destination, { flags: 'wx' })
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject) })
    return {
      stream,
      finish: () => new Promise((resolve, reject) => {
        if (stream.closed) return resolve()
        stream.once('error', reject); stream.once('close', resolve)
        if (!stream.writableEnded) stream.end()
      }),
      abort: () => stream.destroy(),
    }
  },
  createFolder: (destination) => fsp.mkdir(destination),
  remove: (destination) => fsp.rm(destination, { force: true }),
}

/**
 * Copies one file: success needs the end of the source, the source's final
 * confirmation and then the destination's. Anything else aborts the writer.
 */
const copyStream = async (reader, writer, signal) => {
  try {
    await pipeline(reader.stream, writer.stream, { end: false, ...(signal ? { signal } : {}) })
    await reader.finish()
  } catch (error) {
    writer.abort?.()
    await reader.finish().catch(() => {})
    throw signal?.aborted ? providerError('ECANCELLED', 'The operation was cancelled') : error
  }
  await writer.finish()
}

export class RemoteProviders {
  constructor({ ssh, ftp } = {}) {
    this.ssh = ssh
    this.ftp = ftp
  }

  /** A connected remote connection (reconnecting SFTP when it can), or EFILESYSTEM_ID. */
  async ensure(providerId) {
    const kind = providerKind(providerId)
    if (kind === 'sftp' && this.ssh) return this.ssh.ensure(providerId)
    if (kind === 'ftp' && this.ftp) return this.ftp.get(providerId)
    throw unavailable()
  }

  get(providerId) {
    const kind = providerKind(providerId)
    if (kind === 'sftp' && this.ssh) return this.ssh.get(providerId)
    if (kind === 'ftp' && this.ftp) return this.ftp.get(providerId)
    throw unavailable()
  }

  kind(providerId) { return providerKind(providerId) }

  async endpoint(providerId) {
    return providerKind(providerId) === 'local' ? null : this.ensure(providerId)
  }

  async operate(payload, { signal } = {}) {
    const { action } = payload
    const sourceProvider = payload.filesystemId ?? 'local'
    const targetProvider = payload.targetFilesystemId ?? null
    if (action === 'create-file' || action === 'create-folder') {
      validateName(payload.name)
      const target = await this.endpoint(targetProvider)
      if (!target) throw unavailable()
      if (typeof payload.targetDirectory !== 'string') throw providerError('EINVAL', 'A destination folder is required')
      const destination = target.resolve(posix.join(payload.targetDirectory, payload.name))
      if (action === 'create-folder') await target.createFolder(destination, { signal })
      else await target.createEmptyFile(destination, { signal })
      return { action, sourcePath: null, targetDirectory: payload.targetDirectory, destinationPath: destination }
    }
    if (typeof payload.sourcePath !== 'string') throw providerError('EINVAL', 'A source path is required')
    const source = await this.endpoint(sourceProvider)
    if (action === 'delete') {
      if (!source) throw unavailable()
      await source.remove(payload.sourcePath, { signal })
      return { action, sourcePath: payload.sourcePath, targetDirectory: null, destinationPath: null }
    }
    if (action === 'rename') {
      validateName(payload.name)
      if (!source) throw unavailable()
      const from = source.resolve(payload.sourcePath)
      const destination = source.resolve(posix.join(posix.dirname(from), payload.name))
      await source.rename(from, destination, { signal })
      return { action, sourcePath: from, targetDirectory: posix.dirname(from), destinationPath: destination }
    }
    if (action === 'link') throw providerError('ENOTSUPPORTED', 'Symbolic links are not available for cross-provider operations')
    if (action !== 'copy' && action !== 'move') throw providerError('EINVAL', 'Unknown file operation')
    if (typeof payload.targetDirectory !== 'string') throw providerError('EINVAL', 'A destination folder is required')
    const target = await this.endpoint(targetProvider ?? 'local')
    const copyName = action === 'copy' && payload.name != null ? (validateName(payload.name), payload.name) : null
    const sourceName = copyName ?? (source ? posix.basename(payload.sourcePath) : path.basename(payload.sourcePath))
    // The selected item (or its Copy As name) follows the same name rules
    // as recursive children, so it cannot point outside the destination.
    const destination = target
      ? (unsafeEntryNameCheck(sourceName), target.resolve(posix.join(payload.targetDirectory, sourceName)))
      : resolveInsideRoot(localChild(await verifyRealPathInsideRoot(resolveInsideRoot(payload.targetDirectory)), sourceName))
    const sameRemote = Boolean(source) && sourceProvider === targetProvider
    if (sameRemote) {
      const resolvedSource = source.resolve(payload.sourcePath)
      if (resolvedSource === destination) throw providerError('ESAMEPATH', 'The item is already in this folder')
      const stat = await source.stat(resolvedSource, { signal })
      if (stat?.isDirectory && destination.startsWith(`${resolvedSource.replace(/\/$/, '')}/`)) {
        throw providerError('ECYCLE', 'A folder cannot be copied or moved into itself')
      }
    }
    if (action === 'move' && sameRemote) {
      await source.rename(source.resolve(payload.sourcePath), destination, { signal })
    } else {
      await this.copy(source, payload.sourcePath, target, destination, signal)
      if (action === 'move') {
        // The source is removed only after the whole copy succeeded.
        try {
          if (source) await source.remove(payload.sourcePath, { signal })
          else await fsp.rm(await verifyRealPathInsideRoot(resolveInsideRoot(payload.sourcePath)), { recursive: true })
        } catch {
          throw providerError('EPARTIAL_MOVE', 'The copy completed, but the source could not be removed', { partialResult: { destinationPath: destination } })
        }
      }
    }
    return { action, sourcePath: payload.sourcePath, targetDirectory: payload.targetDirectory, destinationPath: destination }
  }

  /** Recursive copy between any two providers (`null` = local). */
  async copy(source, sourcePath, target, destination, signal) {
    checkCancelled(signal)
    const from = source ? source : localEndpoint
    const to = target ? target : localEndpoint
    const resolved = source ? source.resolve(sourcePath) : await verifyRealPathInsideRoot(resolveInsideRoot(sourcePath))
    let directory
    if (source) {
      const stat = await source.stat(resolved, { signal })
      if (!stat) throw providerError('ENOENT', 'The source no longer exists', { path: resolved })
      directory = stat.isDirectory
    } else directory = await localEndpoint.isDirectory(resolved)
    if (directory) {
      const names = await from.childNames(resolved, { signal })
      // Every name is checked before anything is created, so a server cannot
      // steer a copy outside the destination folder.
      for (const name of names) {
        if (unsafeEntryName(name)) throw unsafeName(resolved)
        if (!target) localChild(destination, name)
      }
      await to.createFolder(destination, { signal })
      for (const name of names) {
        await this.copy(
          source, source ? posix.join(resolved, name) : path.join(resolved, name),
          target, target ? posix.join(destination, name) : localChild(destination, name), signal,
        )
      }
      return
    }
    const reader = from.openRead(resolved, { signal })
    let writer
    try {
      writer = await to.createNew(destination, { signal })
    } catch (error) {
      reader.stream.destroy()
      await reader.finish().catch(() => {})
      throw error
    }
    try {
      await copyStream(reader, writer, signal)
    } catch (error) {
      // The destination was created by this copy, so a partial file is
      // removed. Best effort: the original error is reported either way.
      await to.remove(destination).catch(() => {})
      throw error.path ? error : Object.assign(error, { path: destination })
    }
  }
}

const unsafeEntryNameCheck = (name) => {
  if (unsafeEntryName(name)) throw providerError('EINVALID_NAME', 'The name cannot contain slashes or control characters')
}
