import { defineAsyncComponent } from 'vue'
import { sqlite } from '../../api/sqlite.js'
export const sqliteHandler = Object.freeze({
  id: 'sqlite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'], icon: 'mdi-database-outline',
  component: defineAsyncComponent(() => import('./SqliteEditor.vue')),
  createTab: common => ({ ...common, sessionId: null, objects: [], inTransaction: false, loading: true, error: null }),
  async load(tab, options) {
    const response = await sqlite.open({ providerId: tab.filesystemId, path: tab.filePath }, options)
    if (response.ok) Object.assign(tab, { sessionId: response.sessionId, objects: response.objects })
    return response
  },
  dispose: tab => { void sqlite.close(tab.sessionId); tab.sessionId = null },
})
