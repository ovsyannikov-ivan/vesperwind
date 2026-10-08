import { computed, reactive, ref, watch } from 'vue'
import { entryChange, relocatePath } from './useEntryChanges.js'
import { getEditorLanguage } from '../utils/editorLanguages.js'
import { useTextFiles } from './useTextFiles.js'
import { media } from '../api/media.js'
import { getDocumentHandler } from '../editor/documentHandlers.js'
import { filesystem } from '../api/filesystem.js'
import { settings } from './settingsState.js'
import { prepareTextSave } from '../editor/formatting/saveFormatting.js'

const tabs = ref([])
const activeTabId = ref(null)
let tabSequence = 0
const preparationControllers = new Map()

watch(entryChange, (change) => {
  if (change?.action !== 'rename') return
  for (const tab of tabs.value) {
    if (tab.filesystemId !== change.providerId) continue
    tab.filePath = relocatePath(tab.filePath, change)
    tab.fileName = tab.filePath.split('/').at(-1)
    tab.sourceRootPath = relocatePath(tab.sourceRootPath, change)
    tab.sourceRootName = tab.sourceRootPath?.split('/').at(-1)
    if (tab.type === 'text') tab.language = getEditorLanguage(tab.fileName)
  }
})

const createTabId = (filesystemId, filePath) =>
  JSON.stringify([filesystemId, filePath])

const createCommonTab = (id, filesystemId, context) => ({
  id,
  type: context.type,
  filesystemId,
  filePath: context.node.path,
  fileName: context.node.name,
  sourcePane: context.sourcePane,
  sourceRootPath: context.sourceRootPath,
  sourceRootName: context.sourceRootName,
  filesystemRoot: context.filesystemRoot,
  homePath: context.homePath || '',
})

export const useEditorWorkspace = () => {
  const { readTextFile, writeTextFile } = useTextFiles()
  const activeTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value) || null,
  )

  const activateTab = (tabId) => {
    if (tabs.value.some((tab) => tab.id === tabId)) {
      activeTabId.value = tabId
    }
  }

  const preparePdfTab = async (tab) => {
    if (!tab || !['pdf', 'presentation'].includes(tab.type) || tab.loading) return tab

    tab.loading = true
    tab.error = null
    tab.sourceUrl = ''
    tab.pdfBytes = null
    tab.statusMessage = 'Preparing file…'
    preparationControllers.get(tab.id)?.abort()
    const controller = new AbortController()
    preparationControllers.set(tab.id, controller)

    try {
      let response
      if (tab.type === 'presentation') {
        const { loadPresentation } = await import('../modules/presentation/presentationFile.js')
        if (controller.signal.aborted) return tab
        response = await loadPresentation(tab, { signal: controller.signal })
      } else {
        response = await media.prepare({
          providerId: tab.filesystemId,
          path: tab.filePath,
        }, {
          signal: controller.signal,
          onStatus: (status) => {
            tab.statusMessage = status?.userMessage || 'Preparing file…'
            tab.preparationProgress = status?.progress ?? null
          },
        })
      }

      if (controller.signal.aborted) {
        return tab
      } else if (!response?.ok) {
        tab.error = response?.error || { message: 'Unable to prepare this file' }
      } else {
        if (tab.type === 'pdf') tab.sourceUrl = response.source
      }
    } catch (error) {
      tab.error = {
        code: error?.code || 'EMEDIA_PREPARE',
        message: error?.message || 'Unable to prepare this file',
      }
    } finally {
      if (preparationControllers.get(tab.id) === controller) {
        preparationControllers.delete(tab.id)
      }
      if (!controller.signal.aborted) tab.loading = false
    }

    return tab
  }

  const retryPdfTab = (tabId) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)
    return preparePdfTab(tab)
  }

  const openFile = async (context) => {
    const filesystemId = context.filesystemId || 'local'
    const id = createTabId(filesystemId, context.node.path)
    const existingTab = tabs.value.find((tab) => tab.filesystemId === filesystemId && tab.filePath === context.node.path)

    if (existingTab) {
      activeTabId.value = existingTab.id
      if (['pdf', 'presentation'].includes(existingTab.type) && existingTab.error) {
        void preparePdfTab(existingTab)
      }
      return existingTab
    }

    const handler = getDocumentHandler(context.type || 'text')
    if (!handler) return null
    const type = handler.id
    // A renamed tab keeps its model ID; reopening its old path needs a fresh ID.
    const uniqueId = tabs.value.some((tab) => tab.id === id) ? `${id}:${++tabSequence}` : id
    const common = createCommonTab(uniqueId, filesystemId, { ...context, type })
    common.language = getEditorLanguage(common.fileName)
    const tab = reactive(handler.createTab(common))
    tabs.value.push(tab)
    activeTabId.value = uniqueId

    const controller = new AbortController()
    if (!['pdf', 'presentation'].includes(type)) preparationControllers.set(tab.id, controller)
    try {
      const response = await handler.load(tab, {
        readTextFile, preparePdfTab, signal: controller.signal,
        onStatus: (status) => {
          tab.statusMessage = status?.userMessage || 'Preparing file…'
          tab.preparationProgress = status?.progress ?? null
        },
      })
      if (!controller.signal.aborted && !response?.ok) {
        tab.error = response?.error || { message: 'Unable to open this file' }
      }
    } catch (error) {
      if (!controller.signal.aborted) tab.error = {
        code: error?.code || 'EOPEN_FAILED', message: error?.message || 'Unable to open this file',
      }
    } finally {
      if (preparationControllers.get(tab.id) === controller) preparationControllers.delete(tab.id)
      if (!controller.signal.aborted) tab.loading = false
    }
    return tab
  }

  const updateContent = (tabId, content) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)

    if (!tab || tab.type !== 'text' || tab.loading || tab.error) {
      return
    }

    tab.content = content
    tab.dirty = tab.content !== tab.savedContent
    tab.saveError = null
  }

  const saveTab = async (tabId = activeTabId.value, destination = null) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)

    const handler = tab && getDocumentHandler(tab.type)
    if (!handler?.save || tab.loading || tab.saving || tab.formatting || tab.error) {
      return { ok: false, error: tab?.error || { message: 'No file to save' } }
    }

    if (tab.importedFrom && !destination) {
      return { ok: false, needsSaveAs: true, error: { code: 'ESAVE_AS_REQUIRED', message: 'Imported documents must be saved as DOCX' } }
    }

    if (destination && tab.type === 'word' && !destination.path.toLowerCase().endsWith('.docx')) {
      return { ok: false, error: { code: 'EINVALID_EXTENSION', message: 'Word documents must be saved as .docx' } }
    }

    let contentBeingSaved
    tab.saving = true
    tab.saveError = null
    let response
    let created = false

    try {
      const formatted = await prepareTextSave(tab, destination, settings.value.editor.formatting)
      if (formatted) {
        tab.content = formatted.content
        tab.dirty = tab.content !== tab.savedContent
      }
      contentBeingSaved = tab.content
      const serialized = formatted?.serialized ?? (tab.type === 'text' && tab.formattingEol === 'cr'
        ? contentBeingSaved.replace(/\r\n|\r|\n/g, '\r') : null)
      if (destination) {
        const createdResponse = await filesystem.createFile({ providerId: destination.providerId, path: destination.directoryPath }, destination.name)
        if (!createdResponse.ok) return createdResponse
        created = true
      }
      response = await handler.save(tab, {
        writeTextFile: serialized !== null ? (path, _content, providerId) => writeTextFile(path, serialized, providerId) : writeTextFile,
        destination,
      })
    } catch (error) {
      response = {
        ok: false,
        error: {
          code: error?.code || 'ESAVE_FAILED',
          message: error?.message || 'Unable to save this file',
        },
      }
    } finally {
      tab.saving = false
    }

    if (!response?.ok) {
      if (created) await filesystem.remove({ providerId: destination.providerId, path: destination.path }).catch(() => {})
      tab.saveError = response?.error || { message: 'Unable to save this file' }
      return response
    }

    tab.saveError = null
    handler.saved?.(tab, contentBeingSaved)
    if (destination) {
      tab.filesystemId = destination.providerId
      tab.filePath = destination.path
      tab.fileName = destination.name
      if (tab.type === 'text') tab.language = getEditorLanguage(destination.name)
      tab.importedFrom = null
      tab.sourceRootPath = destination.directoryPath
      tab.sourceRootName = destination.directoryPath.split(/[\\/]/).at(-1) || destination.directoryPath
      tab.filesystemRoot = destination.root || tab.filesystemRoot
    }
    tab.modifiedAt = response.modifiedAt
    return response
  }

  const updatePdfState = (tabId, state) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)

    if (!tab || !['pdf', 'presentation'].includes(tab.type) || !state || typeof state !== 'object') {
      return
    }

    Object.assign(tab, state)
  }

  const closeTab = (tabId) => {
    const index = tabs.value.findIndex((tab) => tab.id === tabId)

    if (index < 0) {
      return
    }

    if (tabs.value[index].saving || tabs.value[index].formatting) return
    preparationControllers.get(tabId)?.abort()
    preparationControllers.delete(tabId)

    tabs.value.splice(index, 1)

    if (activeTabId.value === tabId) {
      activeTabId.value =
        tabs.value[Math.min(index, tabs.value.length - 1)]?.id || null
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activateTab,
    openFile,
    updateContent,
    updatePdfState,
    retryPdfTab,
    saveTab,
    closeTab,
  }
}
