import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'
import { notifyEntryChange } from './useEntryChanges.js'

export const useFileOperations = (providerId = LOCAL_FILESYSTEM_PROVIDER) => {
  const location = (value) =>
    typeof value === 'string'
      ? filesystemLocation(value, providerId)
      : {
          ...filesystemLocation(value?.path, value?.providerId || providerId),
          isDirectory: value?.isDirectory === true,
        }

  const copyEntry = (source, targetDirectory) =>
    filesystem.copy(location(source), location(targetDirectory))

  const moveEntry = (source, targetDirectory) =>
    filesystem.move(location(source), location(targetDirectory))

  const createSymbolicLink = (source, targetDirectory) =>
    filesystem.link(location(source), location(targetDirectory))

  const deleteEntry = (source) => filesystem.remove(location(source))
  const createEntry = async (kind, directory, name) => {
    const target = location(directory)
    return notifyEntryChange(await (kind === 'folder' ? filesystem.createFolder : filesystem.createFile)(target, name), target.providerId)
  }
  const renameEntry = async (sourcePath, name) => {
    const source = location(sourcePath)
    return notifyEntryChange(await filesystem.rename(source, name), source.providerId)
  }

  return {
    copyEntry,
    moveEntry,
    createSymbolicLink,
    deleteEntry,
    createEntry,
    renameEntry,
  }
}
