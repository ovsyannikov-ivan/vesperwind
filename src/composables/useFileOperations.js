import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'

export const useFileOperations = (providerId = LOCAL_FILESYSTEM_PROVIDER) => {
  const location = (path) => filesystemLocation(path, providerId)

  const copyEntry = (sourcePath, targetDirectory) =>
    filesystem.copy(location(sourcePath), location(targetDirectory))

  const moveEntry = (sourcePath, targetDirectory) =>
    filesystem.move(location(sourcePath), location(targetDirectory))

  const createSymbolicLink = (sourcePath, targetDirectory) =>
    filesystem.link(location(sourcePath), location(targetDirectory))

  const deleteEntry = (sourcePath) => filesystem.remove(location(sourcePath))

  return {
    copyEntry,
    moveEntry,
    createSymbolicLink,
    deleteEntry,
  }
}
