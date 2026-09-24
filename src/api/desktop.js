import { backend, backendRuntimeMode } from './backend.js'
import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'
import { normalizeApiResponse } from './response.js'

const unsupported = (message) => ({
  ok: false,
  error: { code: 'ENOTSUPPORTED', message },
})

const operate = async (action, fileRef) => {
  if (backendRuntimeMode !== 'tauri') {
    return unsupported('Desktop integration is available only in the native app')
  }
  if (fileRef?.providerId !== LOCAL_FILESYSTEM_PROVIDER) {
    return unsupported('Desktop integration supports local files only')
  }
  if (typeof fileRef.path !== 'string' || !fileRef.path) {
    return { ok: false, error: { code: 'EINVAL', message: 'A file path is required' } }
  }
  return normalizeApiResponse(
    await backend.request('desktop:operate', {
      action,
      filesystemId: fileRef.providerId,
      path: fileRef.path,
    }),
    'EDESKTOP',
    'Unable to complete the desktop action',
  )
}

const platform = globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''

export const desktop = Object.freeze({
  available: backendRuntimeMode === 'tauri',
  canOpenWith: backendRuntimeMode === 'tauri' && /Mac|Win/i.test(platform),
  revealLabel: /Mac/i.test(platform)
    ? 'Show in Finder'
    : /Win/i.test(platform)
      ? 'Show in Explorer'
      : 'Show in File Manager',
  open: (fileRef) => operate('open', fileRef),
  openWith: (fileRef) => operate('open-with', fileRef),
  reveal: (fileRef) => operate('reveal', fileRef),
})
