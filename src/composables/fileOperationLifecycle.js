// Used by confirmation and drag/drop operations. UI ownership is explicit so
// an unmounted/superseded dialog cannot receive a result from its predecessor.
export const settleFileOperation = async ({ run, setBusy, refresh, isCurrent = () => true }) => {
  if (isCurrent()) setBusy(true)
  let result
  try { result = await run() }
  catch (error) { result = { ok: false, error: { code: error.code || 'EFILE_OPERATION', message: error.message || 'The file operation failed' } } }
  finally { if (isCurrent()) setBusy(false) }
  if (isCurrent() && !result?.ok) refresh()
  return result
}
