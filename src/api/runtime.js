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

// Desktop shell features are reported by the backend; browser and SEA
// runtimes report none, so the frontend never guesses from the user agent.
export const DEFAULT_CAPABILITIES = Object.freeze({
  nativeFileClipboard: false,
  externalFileDrop: false,
  externalDragOut: false,
  mountDiskImage: false,
  diskImageExtensions: Object.freeze([]),
})

export const normalizeCapabilities = (value) => ({
  nativeFileClipboard: value?.nativeFileClipboard === true,
  externalFileDrop: value?.externalFileDrop === true,
  externalDragOut: value?.externalDragOut === true,
  mountDiskImage: value?.mountDiskImage === true,
  diskImageExtensions: Array.isArray(value?.diskImageExtensions)
    ? value.diskImageExtensions.filter((item) => typeof item === 'string').map((item) => item.toLowerCase())
    : [],
})

const state = reactive({
  mode: backendRuntimeMode,
  isStandalone: backendRuntimeMode !== 'browser',
  capabilities: { ...DEFAULT_CAPABILITIES },
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
    state.capabilities = normalizeCapabilities(response.capabilities)
  }

  return response
}

state.getInfo = getInfo

export const runtime = readonly(state)
