const trimTrailingSeparators = (value) => {
  if (value === '/') {
    return value
  }

  return value.replace(/\/+$/, '')
}

export const buildPathBreadcrumbs = (filesystemRoot, currentPath) => {
  if (!filesystemRoot?.path) {
    return []
  }

  const rootPath = trimTrailingSeparators(filesystemRoot.path)
  const targetPath = trimTrailingSeparators(currentPath || rootPath)
  const rootCrumb = {
    name: filesystemRoot.name || rootPath,
    path: rootPath,
  }
  const isInsideRoot =
    targetPath === rootPath ||
    (rootPath === '/' ? targetPath.startsWith('/') : targetPath.startsWith(`${rootPath}/`))

  if (!isInsideRoot || targetPath === rootPath) {
    return [rootCrumb]
  }

  const relativePath =
    rootPath === '/' ? targetPath.slice(1) : targetPath.slice(rootPath.length + 1)
  let accumulatedPath = rootPath

  return relativePath.split('/').reduce(
    (crumbs, segment) => {
      accumulatedPath =
        accumulatedPath === '/' ? `/${segment}` : `${accumulatedPath}/${segment}`
      crumbs.push({ name: segment, path: accumulatedPath })
      return crumbs
    },
    [rootCrumb],
  )
}
