import { filterVisibleFilesystemEntries } from '../utils/fileVisibility.js'
import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'
import { useSettings } from './useSettings.js'

export const useFilesystem = (providerId = LOCAL_FILESYSTEM_PROVIDER) => {
  const { settings } = useSettings()
  const getRoot = () => filesystem.getRoot(providerId)
  const listDirectory = async (directoryPath) => {
    const response = await filesystem.readDir(
      filesystemLocation(directoryPath, providerId),
    )

    if (!response?.ok) {
      return response
    }

    return {
      ...response,
      entries: filterVisibleFilesystemEntries(
        response.entries,
        settings.value.filesystem.hiddenNameSuffixes,
      ),
    }
  }

  return {
    getRoot,
    listDirectory,
  }
}
