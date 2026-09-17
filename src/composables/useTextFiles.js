import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'

export const useTextFiles = () => {
  const readTextFile = (
    filePath,
    filesystemId = LOCAL_FILESYSTEM_PROVIDER,
    options,
  ) =>
    filesystem.readText(filesystemLocation(filePath, filesystemId), options)

  const writeTextFile = (
    filePath,
    content,
    filesystemId = LOCAL_FILESYSTEM_PROVIDER,
    options,
  ) =>
    filesystem.writeText(
      filesystemLocation(filePath, filesystemId),
      content,
      options,
    )

  return { readTextFile, writeTextFile }
}
