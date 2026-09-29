// Editor instances belong to their Vue tabs. This map exposes only serialization
// to the document handler and is cleared by each component on unmount.
const instances = new Map()

export const attachDocumentRuntime = (tabId, runtime) => {
  instances.set(tabId, runtime)
  return () => { if (instances.get(tabId) === runtime) instances.delete(tabId) }
}

export const getDocumentRuntime = (tabId) => instances.get(tabId)
export const documentRuntimeCount = () => instances.size
