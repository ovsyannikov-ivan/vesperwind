import { backend } from './backend.js'
import { startFilesystemSearch } from './filesystemSearch.js'
import { content } from './content.js'
import { normalizeApiResponse } from './response.js'
import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'

export {
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from './filesystemLocation.js'

const providerIdOf = (location) =>
  location?.providerId || LOCAL_FILESYSTEM_PROVIDER

const getRoot = async (providerId = LOCAL_FILESYSTEM_PROVIDER) =>
  normalizeApiResponse(
    await backend.request('filesystem:root', {
      filesystemId: providerId,
    }),
    'EFILESYSTEM_ROOT',
    'Unable to load filesystem root',
  )

const readDir = async (location, options = {}) =>
  normalizeApiResponse(
    await backend.request('filesystem:list', {
      filesystemId: providerIdOf(location),
      path: location?.path,
    }, options),
    'EFILESYSTEM_LIST',
    'Unable to read this folder',
  )

const readText = async (location, options = {}) => {
  const preparation = await content.prepare(location, options)
  if (!preparation.ok) return preparation
  return normalizeApiResponse(
    await backend.request('filesystem:read-text', {
      filesystemId: providerIdOf(location),
      path: location?.path,
      ...(options.maxBytes != null ? { maxBytes: options.maxBytes } : {}),
      ...(options.strictText ? { strictText: true } : {}),
    }),
    'ETEXTFILE_READ',
    'Unable to open this file',
  )
}

const writeText = async (location, value, options) => {
  const preparation = await content.prepare(location, options)
  if (!preparation.ok) return preparation
  return normalizeApiResponse(
    await backend.request(
      'filesystem:write-text',
      {
        filesystemId: providerIdOf(location),
        path: location?.path,
        content: value,
      },
      { timeout: 30_000 },
    ),
    'ETEXTFILE_WRITE',
    'Unable to save this file',
  )
}

// Binary payloads cross the shared socket/Tauri boundary as base64. The public
// API deals only in bytes and file references, independent of the provider.
const decodeBytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
const encodeBytes = (bytes) => {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const readBinary = async (location, options) => {
  const preparation = await content.prepare(location, options)
  if (!preparation.ok) return preparation
  const response = normalizeApiResponse(
    await backend.request('filesystem:read-binary', {
      filesystemId: providerIdOf(location), path: location?.path,
    }, { timeout: 60_000 }),
    'EBINARY_READ', 'Unable to open this file',
  )
  return response.ok ? { ...response, bytes: decodeBytes(response.base64) } : response
}

const writeBinary = async (location, bytes, options) => {
  const preparation = await content.prepare(location, options)
  if (!preparation.ok) return preparation
  return normalizeApiResponse(
    await backend.request('filesystem:write-binary', {
      filesystemId: providerIdOf(location), path: location?.path,
      base64: encodeBytes(bytes),
    }, { timeout: 60_000 }),
    'EBINARY_WRITE', 'Unable to save this file',
  )
}

export const OPERATION_TIMEOUT = 10 * 60 * 1000
export const DELETE_TIMEOUT = 30_000
export const REMOTE_OPERATION_TIMEOUT = 120_000

const operate = async ({ action, source, target = null, name, options = {} }) => {
  if (action === 'copy' && source?.isDirectory !== true) {
    const preparation = await content.prepare(source)
    if (!preparation.ok) return preparation
  }

  return normalizeApiResponse(
    await backend.request(
      'filesystem:operate',
      {
        action,
        name,
        filesystemId: providerIdOf(source),
        sourcePath: source?.path,
        targetFilesystemId: target ? providerIdOf(target) : null,
        targetDirectory: target?.path,
      },
      { ...options, timeout: action === 'delete' ? DELETE_TIMEOUT
        : [source, target].some((value) => providerIdOf(value).startsWith('sftp:')) ? REMOTE_OPERATION_TIMEOUT : OPERATION_TIMEOUT },
    ),
    'EFILE_OPERATION',
    'The file operation failed',
  )
}

export const filesystem = Object.freeze({
  resolveLocation: async (location) => normalizeApiResponse(await backend.request('filesystem:resolve-location', {
    filesystemId: providerIdOf(location), path: location?.path,
  }, { timeout: 120_000 }), 'EFILESYSTEM_LOCATION', 'Unable to open this folder'),
  getRoot,
  readDir,
  search: startFilesystemSearch,
  readText,
  writeText,
  readBinary,
  writeBinary,
  copy: (source, target) => operate({ action: 'copy', source, target }),
  move: (source, target) => operate({ action: 'move', source, target }),
  link: (source, target) => operate({ action: 'link', source, target }),
  remove: (source, options) => operate({ action: 'delete', source, options }),
  createFile: (target, name) => operate({ action: 'create-file', target, name }),
  createFolder: (target, name) => operate({ action: 'create-folder', target, name }),
  rename: (source, name) => operate({ action: 'rename', source, name }),
})
