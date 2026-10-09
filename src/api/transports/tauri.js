import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const requestCommands = Object.freeze({
  'filesystem:root': 'filesystem_root',
  'filesystem:resolve-location': 'filesystem_resolve_location',
  'archive:start': 'archive_start',
  'archive:cancel': 'archive_cancel',
  'filesystem:list': 'filesystem_list',
  'filesystem:properties': 'filesystem_properties',
  'filesystem:update-properties': 'filesystem_update_properties',
  'filesystem:calculate-size': 'filesystem_calculate_size',
  'filesystem:calculate-size-cancel': 'filesystem_calculate_size_cancel',
  'filesystem:search': 'filesystem_search',
  'filesystem:search-cancel': 'filesystem_search_cancel',
  'filesystem:watch': 'filesystem_watch',
  'filesystem:unwatch': 'filesystem_unwatch',
  'filesystem:read-text': 'filesystem_read_text',
  'filesystem:write-text': 'filesystem_write_text',
  'filesystem:read-binary': 'filesystem_read_binary',
  'filesystem:write-binary': 'filesystem_write_binary',
  'document:convert': 'document_convert',
  'filesystem:operate': 'filesystem_operate',
  'filesystem:operation-cancel': 'filesystem_operation_cancel',
  'document:cancel': 'document_cancel',
  'desktop:operate': 'desktop_operate',
  'content:prepare': 'content_prepare',
  'content:status': 'content_status',
  'content:cancel': 'content_cancel',
  'runtime:info': 'runtime_info',
  'permissions:capabilities': 'permissions_capabilities',
  'permissions:request': 'permissions_request',
  'permissions:prepare-folder': 'permissions_prepare_folder',
  'permissions:cancel': 'permissions_cancel',
  'media:source': 'media_source',
  'video:thumbnail': 'video_thumbnail',
  'media:history': 'media_history',
  'media:chapters': 'media_chapters',
  'media:metadata': 'media_metadata',
  'media:cancel-metadata': 'media_cancel_metadata',
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
  'player:set-visible': 'player_set_visible',
  'player:set-overlay': 'player_set_overlay',
  'player:set-transition-cover': 'player_set_transition_cover',
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
  'ssh:config-hosts': 'ssh_config_hosts',
  'ssh:config-resolve': 'ssh_config_resolve',
  'connections:capabilities': 'connections_capabilities',
  'connections:credential-status': 'connections_credential_status',
  'connections:forget-credential': 'connections_forget_credential',
  'clipboard:write': 'clipboard_write',
  'clipboard:read': 'clipboard_read',
  'clipboard:consume': 'clipboard_consume',
  'drop:read': 'drop_read',
  'drag:start': 'drag_start',
  'disk-image:operate': 'disk_image_operate',
})

const sendCommands = Object.freeze({
  'terminal:input': 'terminal_input',
  'terminal:resize': 'terminal_resize',
  'terminal:close': 'terminal_close',
})

const pushEvents = new Set(['terminal:output', 'terminal:exit', 'ssh:status', 'player:state', 'filesystem:changed', 'filesystem:search-results', 'filesystem:size-progress', 'archive:progress',
  'clipboard:staging', 'clipboard:consumed', 'native-drag:drop', 'native-drag:end', 'native-drag:error'])

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

// Each invocation has one terminal state. Native job cancellation complements
// this UI deadline; a late invoke response can never resolve a newer request.
export const createTauriRequester = (invokeNative) => (eventName, payload = {}, options = {}) => {
  const command = requestCommands[eventName]
  if (!command) return Promise.resolve(normalizeInvokeError({
    code: 'ENOTSUPPORTED', message: `Unsupported native backend request: ${eventName}`,
  }))
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 15_000
  const cancellable = eventName === 'filesystem:operate' || eventName === 'document:convert'
  const permissionRequest = eventName === 'permissions:request' || eventName === 'permissions:prepare-folder'
  const permissionId = permissionRequest ? crypto.randomUUID() : null
  const operationId = cancellable ? crypto.randomUUID() : null
  const args = permissionRequest ? { ...payload, requestId: permissionId }
    : cancellable ? { ...payload, operationId, timeoutMs: Math.max(1, timeout - 250) } : payload
  return new Promise((resolve) => {
    let settled = false
    let invoked = false
    let timer
    const finish = (response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve(response)
    }
    const stop = (code, message) => {
      if (settled) return
      // Sent before completing the UI request. Native watchdog also owns a
      // deadline, so cancellation remains effective if this WebView disappears.
      if (cancellable) void invokeNative(eventName === 'filesystem:operate'
        ? 'filesystem_operation_cancel' : 'document_cancel', { payload: { operationId } }).catch(() => {})
      if (permissionRequest && invoked) void invokeNative('permissions_cancel', { payload: { requestId: permissionId } }).catch(() => {})
      finish({ ok: false, error: { code, message, path: payload.sourcePath } })
    }
    const abort = () => stop('ECANCELLED', 'The operation was cancelled')
    // macOS may wait for a person indefinitely. Ordinary IO deadlines start only
    // after this separate, cancellable permission-preparation request completes.
    if (!permissionRequest) timer = setTimeout(() => stop('ETIMEDOUT', 'The operation did not complete within the allowed time. Vesperwind is ready for another operation.'), timeout)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    Promise.resolve().then(() => {
      if (settled) return
      invoked = true
      return invokeNative(command, { payload: args })
    })
      .then(finish, (error) => finish(normalizeInvokeError(error)))
  })
}

const request = createTauriRequester(invoke)

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

  const ready = listen(eventName, (event) => callback(event.payload))
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
      return true
    })
    .catch(() => false)

  const unsubscribe = () => {
    disposed = true
    unlisten?.()
  }
  unsubscribe.ready = ready
  return unsubscribe
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
