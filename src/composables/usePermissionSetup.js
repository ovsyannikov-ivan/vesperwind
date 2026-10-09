import { ref } from 'vue'
import { permissionsApi } from '../api/permissions.js'
import { useSettings } from './useSettings.js'

const supported = ref(false), open = ref(false), ready = ref(false)
let initialization
export const usePermissionSetup = () => {
  const { settings, loadSettings, saveSettings } = useSettings()
  const initialize = () => initialization ||= (async () => {
    const capabilities = await permissionsApi.capabilities()
    supported.value = capabilities.ok && capabilities.supported
    if (supported.value) {
      const loaded = await loadSettings()
      if (loaded.ok && !settings.value.permissions.setupCompleted) { open.value = true; return }
    }
    ready.value = true
  })()
  const finish = async () => {
    const response = await saveSettings({ ...settings.value, permissions: { setupCompleted: true } })
    if (response.ok) { open.value = false; ready.value = true }
    return response
  }
  const continueWithoutSaving = () => { open.value = false; ready.value = true }
  return { supported, open, ready, initialize, finish, continueWithoutSaving, show: () => { if (supported.value) open.value = true } }
}
