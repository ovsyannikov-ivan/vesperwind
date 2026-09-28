import { parseWorkbook } from '../adapters/sheetjs.js'

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ ok: true, model: parseWorkbook(data.bytes) })
  } catch (error) {
    self.postMessage({ ok: false, error: { code: error?.code || 'ESPREADSHEET_PARSE', message: error?.message || 'Unable to parse workbook' } })
  }
}
