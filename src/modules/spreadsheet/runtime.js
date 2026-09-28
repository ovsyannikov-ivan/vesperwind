const liveEditors = new Map()
export const attachSpreadsheetRuntime = (tabId, runtime) => {
  liveEditors.set(tabId, runtime)
  return () => { if (liveEditors.get(tabId) === runtime) liveEditors.delete(tabId) }
}
export const getSpreadsheetRuntime = (tabId) => liveEditors.get(tabId)
export const spreadsheetRuntimeCount = () => liveEditors.size
