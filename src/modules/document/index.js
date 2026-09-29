import { defineAsyncComponent } from 'vue'

// Only this tiny descriptor is imported during normal application startup.
export const wordHandler = Object.freeze({
  id: 'word',
  extensions: ['docx', 'rtf', 'doc'],
  icon: 'mdi-file-word-outline',
  component: defineAsyncComponent(() => import('./WordEditor.vue')),
  createTab: (common) => ({ ...common, bytes: null, importedFrom: null,
    dirty: false, revision: 0, loading: true, saving: false,
    error: null, saveError: null }),
  load: async (tab, options) => (await import('./services/documentFile.js')).loadDocument(tab, options),
  save: async (tab, options) => (await import('./services/documentFile.js')).saveDocument(tab, options?.destination),
})
