import { spreadsheetHandler } from '../modules/spreadsheet/index.js'
import { wordHandler } from '../modules/document/index.js'

const textHandler = {
  id: 'text', extensions: [], icon: 'mdi-file-code-outline',
  createTab: (common) => ({ ...common, content: '', savedContent: '', dirty: false,
    language: common.language, loading: true, saving: false, error: null, saveError: null }),
  load: async (tab, { readTextFile, signal, onStatus }) => {
    const response = await readTextFile(tab.filePath, tab.filesystemId, { signal, onStatus })
    if (response.ok) {
      tab.content = response.content
      tab.savedContent = response.content
      tab.modifiedAt = response.modifiedAt
    }
    return response
  },
  save: (tab, { writeTextFile, destination }) => writeTextFile(destination?.path || tab.filePath, tab.content, destination?.providerId || tab.filesystemId),
  saved: (tab, content) => { tab.savedContent = content; tab.dirty = tab.content !== content },
}

const pdfHandler = {
  id: 'pdf', extensions: ['pdf'], icon: 'mdi-file-pdf-box',
  createTab: (common) => ({ ...common, sourceUrl: '', loading: true, statusMessage: 'Preparing file…',
    error: null, currentPage: 1, pageCount: 0, zoomMode: 'fit-width', zoom: 1,
    scrollTop: 0, scrollLeft: 0, thumbnailsOpen: true }),
  load: async (tab, { preparePdfTab }) => { tab.loading = false; await preparePdfTab(tab); return { ok: !tab.error, error: tab.error } },
}

const presentationHandler = {
  ...pdfHandler, id: 'presentation', extensions: ['pptx'], icon: 'mdi-file-powerpoint-outline',
  createTab: (common) => ({ ...pdfHandler.createTab(common), pdfBytes: null, zoomMode: 'fit-page' }),
}

export const documentHandlers = Object.freeze([textHandler, pdfHandler, presentationHandler, spreadsheetHandler, wordHandler])
export const getDocumentHandler = (id) => documentHandlers.find((handler) => handler.id === id)
export const getDocumentHandlerForExtension = (extension) =>
  documentHandlers.find((handler) => handler.extensions.includes(extension))
