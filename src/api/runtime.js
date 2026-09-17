import { reactive, readonly } from 'vue'
import { backend, backendRuntimeMode } from './backend.js'
import { normalizeApiResponse } from './response.js'

export const RUNTIME_MODES = Object.freeze(['browser', 'sea', 'tauri'])

export const normalizeRuntimeMode = (info, fallback = 'browser') => {
  if (RUNTIME_MODES.includes(info?.mode)) {
    return info.mode
  }

  // Keep compatibility with an older native backend during rolling upgrades.
  if (info?.runtime === 'tauri') {
    return 'tauri'
  }

  return RUNTIME_MODES.includes(fallback) ? fallback : 'browser'
}

const state = reactive({
  mode: backendRuntimeMode,
  isStandalone: backendRuntimeMode !== 'browser',
})

const getInfo = async () => {
  const response = normalizeApiResponse(
    await backend.request('runtime:info'),
    'ERUNTIME_INFO',
    'Unable to load runtime information',
  )

  if (response.ok) {
    state.mode = normalizeRuntimeMode(response, backendRuntimeMode)
    state.isStandalone =
      typeof response.isStandalone === 'boolean'
        ? response.isStandalone
        : state.mode !== 'browser'
  }

  return response
}

state.getInfo = getInfo

export const runtime = readonly(state)
