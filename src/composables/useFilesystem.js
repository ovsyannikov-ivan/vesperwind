import { filterVisibleFilesystemEntries } from '../utils/fileVisibility.js'
import {
  filesystem,
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../api/filesystem.js'
import { useSettings } from './useSettings.js'

export const useFilesystem = (providerId = LOCAL_FILESYSTEM_PROVIDER) => {
  const { settings } = useSettings()
  const currentProvider = () => typeof providerId === 'function' ? providerId() : providerId
  const getRoot = () => filesystem.getRoot(currentProvider())
  const listDirectory = async (directoryPath, options = {}) => {
    const response = await filesystem.readDir(
      filesystemLocation(directoryPath, options.providerId || currentProvider()), options,
    )

    if (!response?.ok) {
      return response
    }

    return {
      ...response,
      sourceEntryCount: response.entries.length,
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
