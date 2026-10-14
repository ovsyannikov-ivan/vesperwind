import {
  buildFilesystemPathLevels,
  getFilesystemPathName,
  isSameOrDescendantPath,
} from './filesystemPath.js'
import { isComputerPath } from '../../shared/localFilesystem.js'

export const buildPathBreadcrumbs = (filesystemRoot, currentPath) => {
  if (!filesystemRoot?.path) {
    return []
  }

  const navigation = filesystemRoot.navigation
  if (navigation?.computer) {
    const computer = { name: navigation.computer.name, path: navigation.computer.path }
    if (isComputerPath(currentPath)) return [computer]
    const volume = navigation.volumes?.filter(entry => isSameOrDescendantPath(entry.path, currentPath))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (volume) return [computer, ...buildPathBreadcrumbs({ name: volume.name, path: volume.path }, currentPath)]
    // A newly mounted volume can be opened before the root metadata refreshes.
    return [computer, ...buildPathBreadcrumbs({ ...filesystemRoot, navigation: null }, currentPath)]
  }

  return buildFilesystemPathLevels(filesystemRoot.path, currentPath).map(
    (path, index) => ({
      name:
        index === 0
          ? filesystemRoot.name || getFilesystemPathName(path)
          : getFilesystemPathName(path),
      path,
    }),
  )
}
