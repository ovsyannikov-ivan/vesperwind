import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  createDefaultSettings,
  normalizeSettings,
} from '../shared/defaultSettings.js'

const configuredSettingsPath = process.env.VESPERWIND_SETTINGS_PATH?.trim()

const getDefaultSettingsDirectory = () => {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Vesperwind')
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Vesperwind')
  }

  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'vesperwind',
  )
}

export const settingsFilePath = path.resolve(
  configuredSettingsPath ||
    path.join(getDefaultSettingsDirectory(), 'settings.json'),
)

let cachedSettings = null
let pendingWrite = Promise.resolve()

const writeSettingsFile = async (settings) => {
  const directory = path.dirname(settingsFilePath)
  const temporaryPath = `${settingsFilePath}.${process.pid}.${randomUUID()}.tmp`

  try {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await fs.rename(temporaryPath, settingsFilePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

const persistSettings = (settings) => {
  pendingWrite = pendingWrite
    .catch(() => {})
    .then(() => writeSettingsFile(settings))
  return pendingWrite
}

export const loadSettings = async () => {
  if (cachedSettings) {
    return cachedSettings
  }

  try {
    const storedSettings = JSON.parse(await fs.readFile(settingsFilePath, 'utf8'))
    cachedSettings = normalizeSettings(storedSettings)

    if (JSON.stringify(storedSettings) !== JSON.stringify(cachedSettings)) {
      await persistSettings(cachedSettings)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }

    cachedSettings = createDefaultSettings()
    await persistSettings(cachedSettings)
  }

  return cachedSettings
}

export const saveSettings = async (value) => {
  const nextSettings = normalizeSettings(value)
  await persistSettings(nextSettings)
  cachedSettings = nextSettings
  return cachedSettings
}

export const resetSettings = async () => saveSettings(createDefaultSettings())

const serializeSettingsError = (error) => ({
  code: error?.code || 'ESETTINGS',
  message: error instanceof SyntaxError
    ? 'The settings file contains invalid JSON'
    : 'Unable to read or save settings',
})

const createSuccessResponse = (settings) => ({
  ok: true,
  settings,
  storagePath: settingsFilePath,
})

export const registerSettingsHandlers = (socket) => {
  socket.on('settings:get', async (_payload, acknowledge) => {
    try {
      acknowledge?.(createSuccessResponse(await loadSettings()))
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeSettingsError(error) })
    }
  })

  socket.on('settings:update', async (payload, acknowledge) => {
    try {
      acknowledge?.(createSuccessResponse(await saveSettings(payload?.settings)))
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeSettingsError(error) })
    }
  })

  socket.on('settings:reset', async (_payload, acknowledge) => {
    try {
      acknowledge?.(createSuccessResponse(await resetSettings()))
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeSettingsError(error) })
    }
  })
}
