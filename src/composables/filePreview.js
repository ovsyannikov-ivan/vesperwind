import { filesystem } from '../api/filesystem.js'
import { media } from '../api/media.js'
import { TEXT_PREVIEW_MAX_BYTES } from '../../shared/textPreview.js'
import { getFileExtension } from '../../shared/mediaTypes.js'

export const createPreviewState = (node, providerId, kind, prefix = 'quick-look') => ({
  kind, node, providerId, loading: !['metadata', 'video'].includes(kind), error: null, message: '', content: '', sourceUrl: '',
  statusMessage: 'Preparing file…', preparationProgress: null, id: `${prefix}:${providerId}:${node.path}`,
  filePath: node.path, fileName: node.name, filesystemId: providerId,
  currentPage: 1, pageCount: 0, zoomMode: prefix === 'properties' ? 'fit-page' : 'fit-width', zoom: 1,
  scrollTop: 0, scrollLeft: 0, thumbnailsOpen: false,
})
// One text/PDF/Office loading pipeline for temporary viewers; no editor state or history.
export const loadFilePreview = async (target, { signal, io = filesystem, prepareMedia = media.prepare,
  nativeAudio = false, onBinaryTransportStream, label = 'Quick Look' } = {}) => {
  if (signal?.aborted) return
  const options = { signal, onStatus: (status) => { if (!signal?.aborted) {
    target.statusMessage = status?.userMessage || 'Preparing file…'
    target.preparationProgress = status?.progress ?? null
  } } }
  target.loading = true
  try {
    const location = { providerId: target.providerId, path: target.node.path }
    let result
    if (target.kind === 'text') {
      if (target.node.size > TEXT_PREVIEW_MAX_BYTES) { target.message = `This text file is too large for ${label}.`; return }
      result = await io.readText(location, { ...options, maxBytes: TEXT_PREVIEW_MAX_BYTES, strictText: true })
      if (result.ok && !signal?.aborted) target.content = result.content
      else if (result.error?.code === 'ETEXT_BINARY' && getFileExtension(target.node.name) === 'ts' && !signal?.aborted) {
        target.kind = 'video'; await onBinaryTransportStream?.(); return
      } else if (result.error?.code === 'EFILE_TOO_LARGE') target.message = `This text file is too large for ${label}.`
    } else if (['audio', 'pdf', 'image'].includes(target.kind)) {
      result = await prepareMedia(location, { ...options, native: target.kind === 'audio' && nativeAudio })
      if (result.ok && !signal?.aborted) target.sourceUrl = result.source
    } else if (target.kind === 'presentation') {
      const { loadPresentation } = await import('../modules/presentation/presentationFile.js')
      if (!signal?.aborted) result = await loadPresentation(target, options, io)
    } else if (target.kind === 'word') {
      const { loadDocument } = await import('../modules/document/services/documentFile.js')
      if (!signal?.aborted) result = await loadDocument(target, options, io)
    } else if (target.kind === 'spreadsheet') {
      const { loadSpreadsheet } = await import('../modules/spreadsheet/services/spreadsheetFile.js')
      if (!signal?.aborted) result = await loadSpreadsheet(target, options, io)
    }
    if (!signal?.aborted && result && !result.ok && !target.message) target.error = result.error
  } catch (error) {
    if (!signal?.aborted) target.error = { message: error.message || 'Unable to preview this file' }
  } finally { if (!signal?.aborted) target.loading = false }
}
