import { filterVisibleFilesystemEntries } from '../utils/fileVisibility.js'
import { request } from '../socket/request.js'
import { useSettings } from './useSettings.js'

export const useFilesystem = () => {
  const { settings } = useSettings()
  const getRoot = () => request('filesystem:root')
  const listDirectory = async (directoryPath) => {
    const response = await request('filesystem:list', { path: directoryPath })

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
