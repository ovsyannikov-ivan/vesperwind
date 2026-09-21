import { backend, backendRuntimeMode } from '../api/backend.js'

export const PlayerStatus = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDED: 'ended',
  ERROR: 'error',
  CLOSED: 'closed',
})

const initialState = () => ({
  status: PlayerStatus.IDLE,
  source: '',
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  subtitleDelay: 0,
  tracks: [],
  diagnostics: null,
  error: null,
})

export class MediaPlayerBackend {
  constructor() {
    this.state = initialState()
    this.listeners = new Set()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot() {
    return { ...this.state }
  }

  update(next) {
    Object.assign(this.state, next)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export class WebMediaPlayerBackend extends MediaPlayerBackend {
  constructor(element, { autoplay = false } = {}) {
    super()
    this.element = element
    this.autoplay = autoplay
    this.disposers = []
    this.bindEvents()
  }

  bindEvents() {
    const events = {
      loadstart: () => this.update({ status: PlayerStatus.LOADING, error: null }),
      loadedmetadata: () => this.update({
        status: this.element.paused ? PlayerStatus.READY : PlayerStatus.PLAYING,
        duration: Number.isFinite(this.element.duration) ? this.element.duration : 0,
      }),
      play: () => this.update({ status: PlayerStatus.PLAYING }),
      pause: () => this.update({ status: PlayerStatus.PAUSED }),
      ended: () => this.update({ status: PlayerStatus.ENDED }),
      timeupdate: () => this.update({ currentTime: this.element.currentTime || 0 }),
      durationchange: () => this.update({
        duration: Number.isFinite(this.element.duration) ? this.element.duration : 0,
      }),
      volumechange: () => this.update({
        volume: this.element.volume,
        muted: this.element.muted,
      }),
      error: () => this.update({
        status: PlayerStatus.ERROR,
        error: this.element.error || { message: 'Media playback failed' },
      }),
    }
    for (const [name, listener] of Object.entries(events)) {
      this.element.addEventListener(name, listener)
      this.disposers.push(() => this.element.removeEventListener(name, listener))
    }
  }

  async setSource(source) {
    if (source === this.state.source) return
    this.element.pause()
    this.element.src = source
    this.update({ ...initialState(), source, status: PlayerStatus.LOADING })
    this.element.load()
    if (this.autoplay) await this.play()
  }

  async play() {
    await this.element.play()
  }

  pause() {
    this.element.pause()
  }

  seek(seconds) {
    this.element.currentTime = Math.max(0, Number(seconds) || 0)
  }

  setVolume(volume) {
    this.element.volume = Math.max(0, Math.min(1, Number(volume) || 0))
  }

  setMuted(muted) {
    this.element.muted = Boolean(muted)
  }

  stop() {
    this.pause()
    this.seek(0)
  }

  close() {
    if (this.state.status === PlayerStatus.CLOSED) return
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.update({ ...initialState(), status: PlayerStatus.CLOSED })
    this.listeners.clear()
  }
}

export class NativeMpvPlayerBackend extends MediaPlayerBackend {
  constructor({ autoplay = false, transport = backend } = {}) {
    super()
    this.autoplay = autoplay
    this.transport = transport
    this.closed = false
    this.unsubscribe = this.transport.subscribe('player:state', (state) => {
      if (!state || this.closed) return
      this.update({
        status: state.status || this.state.status,
        currentTime: state.currentTime ?? this.state.currentTime,
        duration: state.duration ?? this.state.duration,
        volume: state.volume ?? this.state.volume,
        muted: state.muted ?? this.state.muted,
        subtitleDelay: state.subtitleDelay ?? this.state.subtitleDelay,
        tracks: state.tracks || this.state.tracks,
        diagnostics: state.diagnostics ?? this.state.diagnostics,
        error: state.error ? { message: state.error } : null,
      })
    })
  }

  async request(eventName, payload = {}) {
    const response = await this.transport.request(eventName, payload)
    if (!response?.ok) {
      const error = response?.error || { message: 'Native media playback failed' }
      this.update({ status: PlayerStatus.ERROR, error })
      throw Object.assign(new Error(error.message), error)
    }
    if (response.state) this.update(response.state)
    return response
  }

  async setSource(source, geometry) {
    const sourceKey = `${source?.providerId || 'local'}:${source?.path || ''}`
    this.update({ ...initialState(), source: sourceKey, status: PlayerStatus.LOADING })
    await this.request('player:open', {
      filesystemId: source?.providerId || 'local',
      path: source?.path || '',
      autoplay: this.autoplay,
      geometry,
    })
  }

  play() { return this.request('player:play') }
  pause() { return this.request('player:pause') }
  seek(seconds) { return this.request('player:seek', { seconds: Math.max(0, Number(seconds) || 0) }) }
  setVolume(volume) { return this.request('player:set-volume', { volume: Math.max(0, Math.min(1, Number(volume) || 0)) }) }
  setMuted(muted) { return this.request('player:set-muted', { muted: Boolean(muted) }) }
  selectTrack(kind, id) { return this.request('player:select-track', { kind, id }) }
  setSubtitleDelay(seconds) { return this.request('player:set-subtitle-delay', { seconds: Number(seconds) || 0 }) }
  setGeometry(geometry) { return this.request('player:set-geometry', { geometry }) }
  setOverlay(visible, geometry, context = {}) {
    return this.request('player:set-overlay', { visible: Boolean(visible), geometry, context })
  }
  refresh() { return this.request('player:snapshot') }
  overlaySnapshot() { return this.request('player:overlay-snapshot') }
  stop() { return this.pause().then(() => this.seek(0)) }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.listeners.clear()
  }

  close() {
    if (this.closed) return
    void this.transport.request('player:close')
    this.update({ ...initialState(), status: PlayerStatus.CLOSED })
    this.dispose()
  }
}

export const getNativePlayerCapabilities = async () => {
  if (backendRuntimeMode !== 'tauri') {
    return { available: false, renderApi: false, customStream: false }
  }
  const response = await backend.request('player:capabilities')
  return response?.ok
    ? response.capabilities
    : { available: false, renderApi: false, customStream: false, reason: response?.error?.message }
}

export const selectPlayerBackend = async () => {
  const capabilities = await getNativePlayerCapabilities()
  return capabilities.available && capabilities.renderApi ? 'mpv' : 'web'
}
