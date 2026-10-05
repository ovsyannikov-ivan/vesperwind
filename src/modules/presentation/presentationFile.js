import { markRaw } from 'vue'
import { filesystem } from '../../api/filesystem.js'
import { convertPresentation } from '../../api/documentConversion.js'

// No persistent conversion cache: every open reads current provider bytes.
// Viewer bytes stay in memory and are copied before PDF.js transfers ownership.
export const loadPresentation = async (tab, options = {}, io = filesystem, converter = convertPresentation) => {
  const cancelled = () => ({ ok: false, error: { code: 'ECANCELLED', message: 'Presentation request was cancelled' } })
  const response = await io.readBinary({ providerId: tab.filesystemId, path: tab.filePath }, options)
  if (options.signal?.aborted) return cancelled()
  if (!response.ok) return response
  tab.statusMessage = 'Preparing presentation…'
  const converted = await converter(response.bytes, options)
  if (options.signal?.aborted) return cancelled()
  if (!converted.ok) return converted
  tab.pdfBytes = markRaw(converted.bytes)
  tab.converterBuildId = converted.buildId
  tab.modifiedAt = response.modifiedAt
  return { ok: true }
}
