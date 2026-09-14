import { ref } from 'vue'
import { createDefaultSettings } from '../../shared/defaultSettings.js'
import { request } from '../socket/request.js'
import { setThemePreference } from './useTheme.js'

const settings = ref(createDefaultSettings())
const storagePath = ref('')
const revision = ref(0)
const loading = ref(false)
let pendingLoad = null

const applyResponse = (response) => {
  if (!response?.ok) {
    return response
  }

  const settingsChanged =
    JSON.stringify(settings.value) !== JSON.stringify(response.settings)
  settings.value = response.settings
  storagePath.value = response.storagePath || ''
  setThemePreference(response.settings.appearance.theme)

  if (settingsChanged) {
    revision.value += 1
  }

  return response
}

export const useSettings = () => {
  const loadSettings = async ({ force = false } = {}) => {
    if (pendingLoad && !force) {
      return pendingLoad
    }

    loading.value = true
    pendingLoad = request('settings:get').then(applyResponse).finally(() => {
      loading.value = false
      pendingLoad = null
    })

    return pendingLoad
  }

  const saveSettings = async (nextSettings) =>
    applyResponse(await request('settings:update', { settings: nextSettings }))

  const resetSettings = async () =>
    applyResponse(await request('settings:reset'))

  return {
    settings,
    storagePath,
    revision,
    loading,
    loadSettings,
    saveSettings,
    resetSettings,
  }
}
