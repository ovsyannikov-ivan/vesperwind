import { markRaw } from 'vue'
import { filesystem } from '../../../api/filesystem.js'
import { parseWorkbook, serializeWorkbook } from '../adapters/sheetjs.js'
import { univerToModel } from '../adapters/univer.js'
import { getSpreadsheetRuntime } from '../runtime.js'

const fileRef = (tab) => ({ providerId: tab.filesystemId, path: tab.filePath })
const failure = (error, code) => ({ ok: false, error: { code: error?.code || code, message: error?.message || 'Unable to process this workbook' } })

const parseOffThread = (bytes, signal) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('../workers/parse.worker.js', import.meta.url), { type: 'module' })
  let settled = false
  const finish = (callback, value) => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', onAbort)
    worker.terminate()
    callback(value)
  }
  const onAbort = () => finish(reject, Object.assign(new Error('Opening was cancelled'), { code: 'ECONTENT_CANCELLED' }))
  worker.onmessage = ({ data }) => data.ok
    ? finish(resolve, data.model)
    : finish(reject, Object.assign(new Error(data.error.message), { code: data.error.code }))
  worker.onerror = (event) => finish(reject, new Error(event.message || 'Workbook parser failed'))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) return onAbort()
  worker.postMessage({ bytes }, [bytes.buffer])
})


export const loadSpreadsheet = async (tab, options = {}, io = filesystem) => {
  try {
    const response = await io.readBinary(fileRef(tab), options)
    if (!response.ok) return response
    // Large workbooks are parsed away from the UI thread. Small ones avoid worker startup.
    const model = typeof Worker !== 'undefined' && response.bytes.byteLength > 1024 * 1024
      ? await parseOffThread(response.bytes, options?.signal)
      : parseWorkbook(response.bytes)
    tab.model = markRaw(model)
    tab.modifiedAt = response.modifiedAt
    return { ok: true }
  } catch (error) { return failure(error, 'ESPREADSHEET_OPEN') }
}

export const saveSpreadsheet = async (tab, io = filesystem) => {
  try {
    const runtime = getSpreadsheetRuntime(tab.id)
    if (!runtime) return failure(new Error('Workbook editor is not ready'), 'ESPREADSHEET_NOT_READY')
    await runtime.finishEditing?.()
    const model = univerToModel(runtime.snapshot())
    const format = tab.fileName.toLowerCase().endsWith('.xls') ? 'xls' : 'xlsx'
    if (tab.model?.warnings?.some((warning) => warning.includes('VBA'))) {
      return failure(new Error('This workbook contains VBA macros that cannot be preserved. Save is blocked to prevent data loss.'), 'EUNSUPPORTED_WORKBOOK')
    }
    const bytes = serializeWorkbook(model, format)
    const revision = tab.revision
    const response = await io.writeBinary(fileRef(tab), bytes)
    if (response.ok) {
      tab.dirty = tab.revision !== revision
      tab.modifiedAt = response.modifiedAt
    }
    return response
  } catch (error) { return failure(error, 'ESPREADSHEET_SAVE') }
}
