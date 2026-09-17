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
  const createEntry = async (kind, directory, name) =>
    notifyEntryChange(await (kind === 'folder' ? filesystem.createFolder : filesystem.createFile)(location(directory), name), providerId)
  const renameEntry = async (sourcePath, name) =>
    notifyEntryChange(await filesystem.rename(location(sourcePath), name), providerId)

  return {
    copyEntry,
    moveEntry,
    createSymbolicLink,
    deleteEntry,
    createEntry,
    renameEntry,
  }
}
