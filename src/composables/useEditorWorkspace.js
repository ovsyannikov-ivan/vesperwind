import { computed, reactive, ref, watch } from 'vue'
import { entryChange, relocatePath } from './useEntryChanges.js'
import { getEditorLanguage } from '../utils/editorLanguages.js'
import { useTextFiles } from './useTextFiles.js'
import { media } from '../api/media.js'

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

const createPdfTab = (common) =>
  reactive({
    ...common,
    sourceUrl: '',
    loading: true,
    statusMessage: 'Preparing file…',
    error: null,
    currentPage: 1,
    pageCount: 0,
    zoomMode: 'fit-width',
    zoom: 1,
    scrollTop: 0,
    scrollLeft: 0,
    thumbnailsOpen: true,
  })

const createTextTab = (common) =>
  reactive({
    ...common,
    content: '',
    savedContent: '',
    dirty: false,
    language: getEditorLanguage(common.fileName),
    loading: true,
    saving: false,
    error: null,
    saveError: null,
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
    if (!tab || tab.type !== 'pdf' || tab.loading) return tab

    tab.loading = true
    tab.error = null
    tab.sourceUrl = ''
    tab.statusMessage = 'Preparing file…'
    preparationControllers.get(tab.id)?.abort()
    const controller = new AbortController()
    preparationControllers.set(tab.id, controller)

    try {
      const response = await media.prepare({
        providerId: tab.filesystemId,
        path: tab.filePath,
      }, {
        signal: controller.signal,
        onStatus: (status) => {
          tab.statusMessage = status?.userMessage || 'Preparing file…'
          tab.preparationProgress = status?.progress ?? null
        },
      })

      if (controller.signal.aborted) {
        return tab
      } else if (!response?.ok) {
        tab.error = response?.error || { message: 'Unable to prepare this file' }
      } else {
        tab.sourceUrl = response.source
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
      if (existingTab.type === 'pdf' && existingTab.error) {
        void preparePdfTab(existingTab)
      }
      return existingTab
    }

    const type = context.type === 'pdf' ? 'pdf' : 'text'
    // A renamed tab keeps its model ID; reopening its old path needs a fresh ID.
    // A counter also works over remote HTTP, without secure-context Web Crypto.
    const uniqueId = tabs.value.some((tab) => tab.id === id) ? `${id}:${++tabSequence}` : id
    const common = createCommonTab(uniqueId, filesystemId, { ...context, type })
    const tab = type === 'pdf' ? createPdfTab(common) : createTextTab(common)
    tabs.value.push(tab)
    activeTabId.value = uniqueId

    if (tab.type === 'pdf') {
      tab.loading = false
      void preparePdfTab(tab)
      return tab
    }

    const controller = new AbortController()
    preparationControllers.set(tab.id, controller)
    try {
      const response = await readTextFile(tab.filePath, tab.filesystemId, {
        signal: controller.signal,
        onStatus: (status) => {
          tab.statusMessage = status?.userMessage || 'Preparing file…'
          tab.preparationProgress = status?.progress ?? null
        },
      })

      if (controller.signal.aborted) {
        return tab
      } else if (!response?.ok) {
        tab.error = response?.error || { message: 'Unable to open this file' }
      } else {
        tab.content = response.content
        tab.savedContent = response.content
        tab.modifiedAt = response.modifiedAt
      }
    } catch (error) {
      tab.error = {
        code: error?.code || 'EOPEN_FAILED',
        message: error?.message || 'Unable to open this file',
      }
    } finally {
      if (preparationControllers.get(tab.id) === controller) {
        preparationControllers.delete(tab.id)
      }
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

  const saveTab = async (tabId = activeTabId.value) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)

    if (!tab || tab.type !== 'text' || tab.loading || tab.saving || tab.error) {
      return { ok: false, error: tab?.error || { message: 'No file to save' } }
    }

    const contentBeingSaved = tab.content
    tab.saving = true
    tab.saveError = null
    let response

    try {
      response = await writeTextFile(
        tab.filePath,
        contentBeingSaved,
        tab.filesystemId,
      )
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
      tab.saveError = response?.error || { message: 'Unable to save this file' }
      return response
    }

    tab.saveError = null
    tab.savedContent = contentBeingSaved
    tab.dirty = tab.content !== contentBeingSaved
    tab.modifiedAt = response.modifiedAt
    return response
  }

  const updatePdfState = (tabId, state) => {
    const tab = tabs.value.find((candidate) => candidate.id === tabId)

    if (!tab || tab.type !== 'pdf' || !state || typeof state !== 'object') {
      return
    }

    Object.assign(tab, state)
  }

  const closeTab = (tabId) => {
    const index = tabs.value.findIndex((tab) => tab.id === tabId)

    if (index < 0) {
      return
    }

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
