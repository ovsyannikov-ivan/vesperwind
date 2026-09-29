import { onBeforeUnmount, reactive, ref } from 'vue'
import { startFilesystemSearch } from '../api/filesystemSearch.js'
import { useSettings } from './useSettings.js'

export const useRecursiveSearch = () => {
  const { settings } = useSettings()
  const search = reactive({ open: false, query: '', type: 'all', scope: 'current', status: 'idle', error: '', limited: false })
  const results = ref([])
  let handle = null
  const cancel = () => { handle?.cancel(); handle = null; results.value = []; search.status = 'idle'; search.limited = false }
  const start = ({ providerId, basePath }) => {
    cancel()
    results.value = []
    search.error = ''
    search.limited = false
    if (!search.query.trim() || !basePath) { search.status = 'idle'; return }
    search.status = 'searching'
    handle = startFilesystemSearch({ filesystemId: providerId, basePath, query: search.query,
      type: search.type, hiddenNameSuffixes: settings.value.filesystem.hiddenNameSuffixes,
      maxResults: 10_000 }, (event) => {
      if (event.entries?.length) results.value = [...results.value, ...event.entries]
      if (event.done) {
        search.status = event.error ? 'error' : event.cancelled ? 'cancelled' : 'done'
        search.error = event.error?.message || ''
        search.limited = Boolean(event.limited)
        handle = null
      }
    })
  }
  const clear = () => { cancel(); search.open = false; search.query = ''; search.status = 'idle'; results.value = [] }
  onBeforeUnmount(cancel)
  return { search, results, start, cancel, clear }
}
