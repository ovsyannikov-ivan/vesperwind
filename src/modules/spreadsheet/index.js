import { defineAsyncComponent } from 'vue'

// This entry point stays small; Univer and SheetJS are imported only when a
// spreadsheet tab is opened or rendered.
export const spreadsheetHandler = Object.freeze({
  id: 'spreadsheet',
  extensions: ['xls', 'xlsx'],
  icon: 'mdi-file-excel-outline',
  component: defineAsyncComponent(() => import('./SpreadsheetEditor.vue')),
  createTab: (common) => ({ ...common, model: null, dirty: false, revision: 0,
    loading: true, saving: false, error: null, saveError: null }),
  load: async (tab, options) => (await import('./services/spreadsheetFile.js')).loadSpreadsheet(tab, options),
  save: async (tab) => (await import('./services/spreadsheetFile.js')).saveSpreadsheet(tab),
})
