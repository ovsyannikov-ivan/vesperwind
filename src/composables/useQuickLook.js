import { computed, ref } from 'vue'
import { canPreviewMedia, getFileExtension, getMediaKind } from '../../shared/mediaTypes.js'
import { DEFAULT_EDITABLE_FILES } from '../../shared/defaultSettings.js'
import { TEXT_PREVIEW_MAX_BYTES } from '../../shared/textPreview.js'
import { isEditableFile } from '../utils/editableFiles.js'
import { filesystem } from '../api/filesystem.js'
import { media } from '../api/media.js'
import { selectPlayerBackend } from '../player/mediaPlayerBackend.js'

export const getQuickLookKind = (entry, editableFiles = DEFAULT_EDITABLE_FILES) => {
  if (!entry || entry.isDirectory) return null
  const extension = getFileExtension(entry.name)
  // .ts is shared by TypeScript and MPEG transport streams. Configured source
  // files get strict text inspection; binary .ts files fall back to the video viewer.
  if (extension === 'ts' && isEditableFile(entry.name, editableFiles)) return 'text'
  if (canPreviewMedia(entry.name)) return getMediaKind(entry.name)
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return 'word'
  if (['xls', 'xlsx'].includes(extension)) return 'spreadsheet'
  if (extension === 'log' || isEditableFile(entry.name, editableFiles)) return 'text'
  return 'metadata'
}

export const useQuickLook = ({ openMedia, closeMedia, beforePlayback, io = filesystem, prepareMedia = media.prepare, selectBackend = selectPlayerBackend }) => {
  const current = ref(null)
  const preview = computed(() => current.value && !['image', 'video'].includes(current.value.kind) ? current.value : null)
  let controller = null
  let generation = 0
  const close = () => {
    generation++
    controller?.abort()
    controller = null
    if (['image', 'video'].includes(current.value?.kind)) closeMedia()
    current.value = null
  }
  const open = async (context, editableFiles) => {
    const kind = getQuickLookKind(context?.node, editableFiles)
    if (!kind) return false
    close()
    const requestGeneration = generation
    if (kind === 'audio') await beforePlayback('audio')
    if (requestGeneration !== generation) return false
    const node = context.node
    const providerId = context.filesystemId || node.providerId || 'local'
    current.value = { kind, node, providerId, loading: !['image', 'video', 'metadata'].includes(kind),
      error: null, message: '', content: '', sourceUrl: '', statusMessage: 'Preparing file…',
      // These are isolated viewer state, never registered with EditorWorkspace.
      id: `quick-look:${providerId}:${node.path}`, filePath: node.path, fileName: node.name, filesystemId: providerId,
      currentPage: 1, pageCount: 0, zoomMode: 'fit-width', zoom: 1, scrollTop: 0, scrollLeft: 0, thumbnailsOpen: false }
    if (kind === 'image' || kind === 'video') {
      await openMedia({ ...context, filesystemId: providerId }, () => requestGeneration === generation)
      return true
    }
    if (kind === 'metadata') return true
    const target = current.value
    controller = new AbortController()
    const signal = controller.signal
    const options = { signal, onStatus: (status) => { if (!signal.aborted) target.statusMessage = status?.userMessage || 'Preparing file…' } }
    try {
      let result
      const location = { providerId, path: node.path }
      if (kind === 'text') {
        if (node.size > TEXT_PREVIEW_MAX_BYTES) {
          target.message = 'This text file is too large for Quick Look.'
          return true
        }
        result = await io.readText(location, { ...options, maxBytes: TEXT_PREVIEW_MAX_BYTES, strictText: true })
        if (result.ok) target.content = result.content
        else if (result.error?.code === 'ETEXT_BINARY' && getFileExtension(node.name) === 'ts' && !signal.aborted) {
          target.kind = 'video'
          await openMedia({ ...context, filesystemId: providerId }, () => !signal.aborted)
          return true
        } else if (result.error?.code === 'EFILE_TOO_LARGE') target.message = 'This text file is too large for Quick Look.'
      } else if (kind === 'audio' || kind === 'pdf') {
        result = kind === 'audio' && await selectBackend('audio') === 'mpv'
          ? { ok: true, source: 'native-audio' } : await prepareMedia(location, options)
        if (result.ok) target.sourceUrl = result.source
      } else if (kind === 'word') {
        const { loadDocument } = await import('../modules/document/services/documentFile.js')
        if (signal.aborted) return false
        result = await loadDocument(target, options, io)
      } else if (kind === 'spreadsheet') {
        const { loadSpreadsheet } = await import('../modules/spreadsheet/services/spreadsheetFile.js')
        if (signal.aborted) return false
        result = await loadSpreadsheet(target, options, io)
      }
      if (!signal.aborted && result && !result.ok && !target.message) target.error = result.error
    } catch (error) {
      if (!signal.aborted) target.error = { message: error.message || 'Unable to preview this file' }
    } finally {
      if (!signal.aborted) target.loading = false
    }
    return true
  }
  return { current, preview, open, close }
}
