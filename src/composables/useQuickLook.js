import { computed, ref } from 'vue'
import { canPreviewMedia, getFileExtension, getMediaKind } from '../../shared/mediaTypes.js'
import { DEFAULT_EDITABLE_FILES } from '../../shared/defaultSettings.js'
import { isEditableFile } from '../utils/editableFiles.js'
import { filesystem } from '../api/filesystem.js'
import { media } from '../api/media.js'
import { selectPlayerBackend } from '../player/mediaPlayerBackend.js'
import { createPreviewState, loadFilePreview } from './filePreview.js'

export const getQuickLookKind = (entry, editableFiles = DEFAULT_EDITABLE_FILES) => {
  if (!entry || entry.isDirectory) return null
  const extension = getFileExtension(entry.name)
  // .ts is shared by TypeScript and MPEG transport streams. Configured source
  // files get strict text inspection; binary .ts files fall back to the video viewer.
  if (extension === 'ts' && isEditableFile(entry.name, editableFiles)) return 'text'
  if (canPreviewMedia(entry.name)) return getMediaKind(entry.name)
  if (extension === 'pdf') return 'pdf'
  if (extension === 'pptx') return 'presentation'
  if (['docx', 'doc', 'rtf'].includes(extension)) return 'word'
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
    current.value = createPreviewState(node, providerId, kind)
    if (kind === 'image' || kind === 'video') {
      await openMedia({ ...context, filesystemId: providerId }, () => requestGeneration === generation)
      return true
    }
    if (kind === 'metadata') return true
    const target = current.value
    controller = new AbortController()
    const signal = controller.signal
    await loadFilePreview(target, { signal, io, prepareMedia,
      nativeAudio: kind === 'audio' && await selectBackend('audio') === 'mpv',
      onBinaryTransportStream: () => openMedia({ ...context, filesystemId: providerId }, () => !signal.aborted) })
    return true
  }
  return { current, preview, open, close }
}
