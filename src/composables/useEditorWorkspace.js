import { computed, reactive, ref } from 'vue'
import { getEditorLanguage } from '../utils/editorLanguages.js'
import { useTextFiles } from './useTextFiles.js'

const tabs = ref([])
const activeTabId = ref(null)

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

  const openFile = async (context) => {
    const filesystemId = context.filesystemId || 'local'
    const id = createTabId(filesystemId, context.node.path)
    const existingTab = tabs.value.find((tab) => tab.id === id)

    if (existingTab) {
      activeTabId.value = id
      return existingTab
    }

    const type = context.type === 'pdf' ? 'pdf' : 'text'
    const common = createCommonTab(id, filesystemId, { ...context, type })
    const tab = type === 'pdf' ? createPdfTab(common) : createTextTab(common)
    tabs.value.push(tab)
    activeTabId.value = id

    if (tab.type === 'pdf') {
      return tab
    }

    try {
      const response = await readTextFile(tab.filePath, tab.filesystemId)

      if (!response?.ok) {
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
      tab.loading = false
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
    saveTab,
    closeTab,
  }
}
