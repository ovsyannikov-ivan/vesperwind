import { defineAsyncComponent } from 'vue'
import { flushMarkdown, loadMarkdown, markdownSaved, saveMarkdown } from './services/markdownFile.js'

// This descriptor and its small file service load at startup; TOAST UI is
// imported with the first Markdown tab or preview.
export const markdownHandler = Object.freeze({
  id: 'markdown',
  extensions: ['md', 'markdown'],
  icon: 'mdi-language-markdown-outline',
  history: true,
  component: defineAsyncComponent(() => import('./MarkdownEditor.vue')),
  createTab: (common) => ({ ...common, content: '', savedContent: '', textFormat: null,
    dirty: false, revision: 0, savingRevision: 0, loading: true, saving: false,
    error: null, saveError: null }),
  load: loadMarkdown,
  flush: flushMarkdown,
  save: saveMarkdown,
  saved: markdownSaved,
})
