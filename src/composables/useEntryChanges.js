import { shallowRef } from 'vue'
import { isSameOrDescendantPath } from '../utils/filesystemPath.js'

// Creation and rename notifications shared by file panels and editor trees.
export const entryChange = shallowRef(null)

export const relocatePath = (path, change) => {
  if (change?.action !== 'rename' || typeof path !== 'string') return path
  const source = change.sourcePath
  return isSameOrDescendantPath(source, path)
    ? `${change.destinationPath}${path.slice(source.length)}`
    : path
}

export const notifyEntryChange = (response, providerId) => {
  if (response.ok) entryChange.value = { ...response.result, providerId }
  return response
}
