import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'

export const useTextFiles = () => {
  const readTextFile = (
    filePath,
    filesystemId = LOCAL_FILESYSTEM_PROVIDER,
  ) =>
    filesystem.readText(filesystemLocation(filePath, filesystemId))

  const writeTextFile = (
    filePath,
    content,
    filesystemId = LOCAL_FILESYSTEM_PROVIDER,
  ) =>
    filesystem.writeText(
      filesystemLocation(filePath, filesystemId),
      content,
    )

  return { readTextFile, writeTextFile }
}
