import { getDocumentHandler, getDocumentHandlerForExtension } from '../editor/documentHandlers.js'
import {
  canPreviewMedia,
  getFileExtension,
  getMediaKind,
} from '../../shared/mediaTypes.js'
import { isEditableFile } from './editableFiles.js'

const mediaTypes = new Set(['image', 'video', 'audio'])

export const getFileOpenType = (fileName, editableFiles = []) => {
  const documentHandler = getDocumentHandlerForExtension(getFileExtension(fileName))
  if (documentHandler) return documentHandler.id

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
  Boolean(getDocumentHandler(type))

export const isMediaOpenType = (type) => mediaTypes.has(type)

export const getEntryOpenAction = (entry, editableFiles = []) => {
  if (entry?.isDirectory) {
    return 'open'
  }

  const type = getFileOpenType(entry?.name, editableFiles)

  if (type === 'text') {
    return 'edit'
  }

  return type ? 'view' : null
}
