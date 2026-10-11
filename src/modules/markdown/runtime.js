// TOAST UI instances belong to their Vue tabs. The handler reaches them only
// through this map, which each component clears on unmount.
const instances = new Map()

export const attachMarkdownRuntime = (tabId, runtime) => {
  instances.set(tabId, runtime)
  return () => { if (instances.get(tabId) === runtime) instances.delete(tabId) }
}

export const getMarkdownRuntime = (tabId) => instances.get(tabId)
export const markdownRuntimeCount = () => instances.size
