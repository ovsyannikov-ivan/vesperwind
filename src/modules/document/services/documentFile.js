import { markRaw } from 'vue'
import { filesystem } from '../../../api/filesystem.js'
import { convertImportedDocument } from '../../../api/documentConversion.js'
import { getDocumentRuntime } from '../runtime.js'

const refOf = (tab) => ({ providerId: tab.filesystemId, path: tab.filePath })
const failure = (error, code) => ({ ok: false, error: { code: error?.code || code, message: error?.message || 'Unable to process this document' } })
export const importFormat = (name) => /\.rtf$/i.test(name) ? 'rtf' : /\.doc$/i.test(name) ? 'doc' : null

export const loadDocument = async (tab, options = {}, io = filesystem, converter = convertImportedDocument) => {
  try {
    const response = await io.readBinary(refOf(tab), options)
    if (!response.ok) return response
    const format = importFormat(tab.fileName)
    let bytes = response.bytes
    if (format) {
      const converted = await converter(bytes, format)
      if (!converted.ok) return converted
      bytes = converted.bytes
      tab.importedFrom = format.toUpperCase()
      tab.dirty = true // Imported data has no DOCX destination until Save As.
    }
    const { readOoxmlPackage } = await import('@docx-editor.dev/core/store')
    const result = readOoxmlPackage(bytes)
    if (!result.ok || !result.package.mainDocumentPart || !result.package.parts?.has?.(result.package.mainDocumentPart)) {
      return failure(new Error(`Invalid or unsupported DOCX: ${result.reason || 'document part missing'}`), 'EDOCX_INVALID')
    }
    tab.bytes = markRaw(bytes)
    tab.modifiedAt = response.modifiedAt
    return { ok: true }
  } catch (error) { return failure(error, 'EDOCX_OPEN') }
}

export const saveDocument = async (tab, destination = null, io = filesystem, runtimeOf = getDocumentRuntime) => {
  if (tab.importedFrom && !destination) return failure(new Error('Imported documents must be saved as DOCX'), 'EDOCX_SAVE_AS_REQUIRED')
  try {
    const runtime = runtimeOf(tab.id)
    if (!runtime) return failure(new Error('Document editor is not ready'), 'EDOCX_NOT_READY')
    const revision = tab.revision
    const bytes = await runtime.save()
    if (!bytes) return failure(new Error('Document editor could not serialize this file'), 'EDOCX_SERIALIZE')
    const response = await io.writeBinary(destination || refOf(tab), new Uint8Array(bytes))
    if (response.ok) {
      tab.dirty = tab.revision !== revision
      tab.modifiedAt = response.modifiedAt
    }
    return response
  } catch (error) { return failure(error, 'EDOCX_SAVE') }
}
