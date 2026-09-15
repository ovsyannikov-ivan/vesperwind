import { backend } from './backend.js'
import { normalizeApiResponse } from './response.js'

const normalizeSettingsResponse = (response) =>
  normalizeApiResponse(
    response,
    'ESETTINGS',
    'Unable to read or save settings',
  )

export const settingsApi = Object.freeze({
  get: async () =>
    normalizeSettingsResponse(await backend.request('settings:get')),
  update: async (settings) =>
    normalizeSettingsResponse(
      await backend.request('settings:update', { settings }),
    ),
  reset: async () =>
    normalizeSettingsResponse(await backend.request('settings:reset')),
})
