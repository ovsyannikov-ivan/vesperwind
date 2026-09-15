import {
  canPreviewMedia,
  getFileExtension,
  getMediaKind,
} from '../../shared/mediaTypes.js'
import { isEditableFile } from './editableFiles.js'

const workspaceDocumentTypes = new Set(['text', 'pdf'])
const mediaTypes = new Set(['image', 'video', 'audio'])

export const getFileOpenType = (fileName, editableFiles = []) => {
  if (getFileExtension(fileName) === 'pdf') {
    return 'pdf'
  }

  const mediaType = getMediaKind(fileName)

  if (mediaType && canPreviewMedia(fileName)) {
    return mediaType
  }

  if (isEditableFile(fileName, editableFiles)) {
    return 'text'
  }

  return null
}

export const isWorkspaceDocumentType = (type) =>
  workspaceDocumentTypes.has(type)

export const isMediaOpenType = (type) => mediaTypes.has(type)
