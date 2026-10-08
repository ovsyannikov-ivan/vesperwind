import { formatText } from './prettier.js'
self.onmessage = async ({ data: { id, request } }) => {
  try { self.postMessage({ id, result: await formatText(request) }) }
  catch (error) { self.postMessage({ id, error: { code: 'EFORMAT', message: `Formatting failed: ${error.message || 'Invalid document'}` } }) }
}
