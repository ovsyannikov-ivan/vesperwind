import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const requestCommands = Object.freeze({
  'filesystem:root': 'filesystem_root',
  'filesystem:list': 'filesystem_list',
  'filesystem:read-text': 'filesystem_read_text',
  'filesystem:write-text': 'filesystem_write_text',
  'filesystem:operate': 'filesystem_operate',
  'content:prepare': 'content_prepare',
  'content:status': 'content_status',
  'content:cancel': 'content_cancel',
  'runtime:info': 'runtime_info',
  'media:source': 'media_source',
  'player:capabilities': 'player_capabilities',
  'player:open': 'player_open',
  'player:play': 'player_play',
  'player:pause': 'player_pause',
  'player:seek': 'player_seek',
  'player:set-volume': 'player_set_volume',
  'player:set-muted': 'player_set_muted',
  'player:select-track': 'player_select_track',
  'player:set-subtitle-delay': 'player_set_subtitle_delay',
  'player:set-geometry': 'player_set_geometry',
  'player:set-overlay': 'player_set_overlay',
  'player:overlay-snapshot': 'player_overlay_snapshot',
  'player:snapshot': 'player_snapshot',
  'player:close': 'player_close',
  'settings:get': 'settings_get',
  'settings:update': 'settings_update',
  'settings:reset': 'settings_reset',
  'terminal:create': 'terminal_create',
  'ssh:connect': 'ssh_connect',
  'ssh:disconnect': 'ssh_disconnect',
  'ssh:status': 'ssh_status',
})

const sendCommands = Object.freeze({
  'terminal:input': 'terminal_input',
  'terminal:resize': 'terminal_resize',
  'terminal:close': 'terminal_close',
})

const pushEvents = new Set(['terminal:output', 'terminal:exit', 'ssh:status', 'player:state'])

const normalizeInvokeError = (error) => ({
  ok: false,
  error: {
    code: error?.code || 'ETAURI_INVOKE',
    message:
      typeof error === 'string'
        ? error
        : error?.message || 'The native backend request failed',
  },
})

const request = async (eventName, payload = {}) => {
  const command = requestCommands[eventName]

  if (!command) {
    return normalizeInvokeError({
      code: 'ENOTSUPPORTED',
      message: `Unsupported native backend request: ${eventName}`,
    })
  }

  try {
    return await invoke(command, { payload })
  } catch (error) {
    return normalizeInvokeError(error)
  }
}

const send = (eventName, payload = {}) => {
  const command = sendCommands[eventName]

  if (command) {
    void invoke(command, { payload }).catch(() => {})
  }
}

const subscribe = (eventName, callback) => {
  if (!pushEvents.has(eventName)) {
    return () => {}
  }

  let disposed = false
  let unlisten = null

  void listen(eventName, (event) => callback(event.payload))
    .then((dispose) => {
      if (disposed) {
        dispose()
      } else {
        unlisten = dispose
      }
    })
    .catch(() => {})

  return () => {
    disposed = true
    unlisten?.()
  }
}

const subscribeToConnection = () => () => {}

const getMediaUrl = ({ path, providerId = 'local' } = {}) => {
  const query = new URLSearchParams({
    path: path || '',
    filesystemId: providerId,
  })

  const origin = /Windows/i.test(globalThis.navigator?.userAgent || '')
    ? 'http://vesperwind-media.localhost'
    : 'vesperwind-media://localhost'

  return `${origin}/content?${query}`
}

const getPreparedMediaSource = async (location) =>
  request('media:source', {
    filesystemId: location?.providerId || 'local',
    path: location?.path,
  })

export const tauriTransport = Object.freeze({
  isConnected: () => true,
  request,
  send,
  subscribe,
  subscribeToConnection,
  getMediaUrl,
  getPreparedMediaSource,
})
