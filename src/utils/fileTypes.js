import { getDocumentHandler, getDocumentHandlerForExtension } from '../editor/documentHandlers.js'
import {
  canPreviewMedia,
  getFileExtension,
  getMediaKind,
} from '../../shared/mediaTypes.js'
import { isEditableFile } from './editableFiles.js'

const mediaTypes = new Set(['image', 'video', 'audio'])

export const getFileOpenType = (fileName, editableFiles = []) => {
  if (/\.m3u8?$/i.test(fileName || '')) return 'playlist'
  const documentHandler = getDocumentHandlerForExtension(getFileExtension(fileName))
  if (documentHandler) return documentHandler.id

  // .ts is both TypeScript and MPEG transport stream. The text handler makes
  // the strict content check; FileManager falls back to video only for binary.
  if (getFileExtension(fileName) === 'ts' && isEditableFile(fileName, editableFiles)) return 'text'

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
