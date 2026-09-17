import {
  buildFilesystemPathLevels,
  getFilesystemPathName,
} from './filesystemPath.js'

export const buildPathBreadcrumbs = (filesystemRoot, currentPath) => {
  if (!filesystemRoot?.path) {
    return []
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
