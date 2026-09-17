import { backend } from './backend.js'
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

const readDir = async (location) =>
  normalizeApiResponse(
    await backend.request('filesystem:list', {
      filesystemId: providerIdOf(location),
      path: location?.path,
    }),
    'EFILESYSTEM_LIST',
    'Unable to read this folder',
  )

const readText = async (location, options) => {
  const preparation = await content.prepare(location, options)
  if (!preparation.ok) return preparation
  return normalizeApiResponse(
    await backend.request('filesystem:read-text', {
      filesystemId: providerIdOf(location),
      path: location?.path,
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

const OPERATION_TIMEOUT = 10 * 60 * 1000

const operate = async ({ action, source, target = null, name }) => {
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
      { timeout: OPERATION_TIMEOUT },
    ),
    'EFILE_OPERATION',
    'The file operation failed',
  )
}

export const filesystem = Object.freeze({
  getRoot,
  readDir,
  readText,
  writeText,
  copy: (source, target) => operate({ action: 'copy', source, target }),
  move: (source, target) => operate({ action: 'move', source, target }),
  link: (source, target) => operate({ action: 'link', source, target }),
  remove: (source) => operate({ action: 'delete', source }),
  createFile: (target, name) => operate({ action: 'create-file', target, name }),
  createFolder: (target, name) => operate({ action: 'create-folder', target, name }),
  rename: (source, name) => operate({ action: 'rename', source, name }),
})
