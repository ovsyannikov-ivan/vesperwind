import { shallowRef } from 'vue'

// Creation and rename notifications shared by file panels and editor trees.
export const entryChange = shallowRef(null)

export const relocatePath = (path, change) => {
  if (change?.action !== 'rename' || typeof path !== 'string') return path
  const source = change.sourcePath
  return path === source || path.startsWith(`${source}/`)
    ? `${change.destinationPath}${path.slice(source.length)}`
    : path
}

export const notifyEntryChange = (response, providerId) => {
  if (response.ok) entryChange.value = { ...response.result, providerId }
  return response
}
