import { backend, backendRuntimeMode } from '../api/backend.js'
import { media } from '../api/media.js'
import { normalizeMediaSource, mediaIdentity } from './mediaSource.js'
import { normalizeChapters, currentChapterIndex, adjacentChapterIndex } from './chapters.js'

export const PlayerStatus = Object.freeze({
  IDLE: 'idle',
  OPENING: 'opening',
  LOADING: 'loading',
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDED: 'ended',
  ERROR: 'error',
  CLOSED: 'closed',
  CLOSING: 'closing',
})

const createPlayerSessionId = () =>
  globalThis.crypto?.randomUUID?.() || `mpv-${Date.now()}-${Math.random().toString(16).slice(2)}`

const initialState = () => ({
  status: PlayerStatus.IDLE,
  endedRevision: 0,
  source: '',
  currentTime: 0,
  seeking: false,
  pendingSeekTime: null,
  duration: 0,
  volume: 1,
  muted: false,
  subtitleDelay: 0,
  tracks: [],
  chapters: [],
  tags: {},
  live: false,
  currentChapterIndex: null,
  currentChapter: null,
  diagnostics: null,
  error: null,
  osd: null,
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
    if (next.chapters !== undefined) this.state.chapters = normalizeChapters(next.chapters)
    this.state.currentChapterIndex = currentChapterIndex(this.state.chapters, this.state.currentTime)
    this.state.currentChapter = this.state.chapters.find((chapter) => chapter.index === this.state.currentChapterIndex) ?? null
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
  selectChapter(index) {
    const chapter = this.state.chapters.find((entry) => entry.index === index)
    if (chapter) return this.seek(chapter.startTime)
  }

  previousChapter() {
    return this.selectChapter(adjacentChapterIndex(this.state.chapters, this.state.currentChapterIndex, -1))
  }

  nextChapter() {
    return this.selectChapter(adjacentChapterIndex(this.state.chapters, this.state.currentChapterIndex, 1))
  }
}

export class WebMediaPlayerBackend extends MediaPlayerBackend {
  constructor(element, { autoplay = false, history = backendRuntimeMode === 'tauri' ? backend : null, historyEnabled = true,
    chapterMetadata = backendRuntimeMode === 'tauri' ? media.getChapters : null } = {}) {
    super()
    this.element = element
    this.autoplay = autoplay
    this.chapterMetadata = chapterMetadata
    this.history = historyEnabled ? history : null
    this.historySession = null
    this.historyReady = false
    this.lastHistorySync = 0
    this.sourceGeneration = 0
    this.closed = false
    this.pendingResume = null
    this.restoreTimer = null
    this.explicitAction = null
    // Resume must complete before any autoplay starts in the WebView.
    if (this.history) this.element.autoplay = false
    this.disposers = []
    this.bindEvents()
  }

  bindEvents() {
    const events = {
      loadstart: () => this.update({ status: PlayerStatus.LOADING, error: null }),
      loadedmetadata: () => {
        this.update({ status: this.element.paused ? PlayerStatus.READY : PlayerStatus.PLAYING,
          duration: Number.isFinite(this.element.duration) ? this.element.duration : 0 })
        if (!this.history) return
        const target = this.pendingResume
        if (target >= 15 && this.element.duration - target > 30) {
          try {
            this.element.currentTime = target
            this.restoreTimer = setTimeout(() => this.finishRestore(false), 10000)
          } catch { this.finishRestore(false) }
        } else this.finishRestore(false)
      },
      seeked: () => {
        this.update({ currentTime: this.element.currentTime || 0 })
        if (this.pendingResume != null && !this.element.seeking && Math.abs(this.element.currentTime - this.pendingResume) <= 1) this.finishRestore(true)
      },
      play: () => { this.eofHandled = false; this.update({ status: PlayerStatus.PLAYING }); this.confirmAction('play') },
      pause: () => {
        this.update({ status: PlayerStatus.PAUSED, currentTime: this.element.currentTime || 0 })
        void this.flushHistory('pause')
        this.confirmAction('pause')
      },
      ended: () => {
        if (this.eofHandled) return
        this.eofHandled = true
        const generation = this.sourceGeneration
        const history = this.flushHistory('eof')
        this.element.pause()
        this.element.currentTime = 0
        this.update({ status: PlayerStatus.PAUSED, currentTime: 0 })
        const notify = () => {
          if (!this.closed && generation === this.sourceGeneration) this.update({ endedRevision: this.state.endedRevision + 1 })
        }
        if (this.history) void history.finally(notify)
        else notify()
      },
      timeupdate: () => {
        this.update({ currentTime: this.element.currentTime || 0 })
        if (this.historyReady && Date.now() - this.lastHistorySync >= 1000) {
          this.lastHistorySync = Date.now()
          void this.flushHistory('tick')
        }
      },
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

  async setSource(source, location) {
    if (this.closed || source === this.state.source) return
    const generation = ++this.sourceGeneration
    clearTimeout(this.restoreTimer)
    this.pendingResume = null
    this.explicitAction = null
    this.eofHandled = false
    await this.flushHistory('close')
    if (this.closed || generation !== this.sourceGeneration) return
    this.historyReady = false
    this.historySession = null
    this.element.pause()
    if (this.history && location?.sourceType !== 'url' && location?.path) {
      const id = createPlayerSessionId()
      const result = await this.history.request('media:history', { event: 'open', sessionId: id, ...location }).catch(() => null)
      if (this.closed || generation !== this.sourceGeneration) {
        void this.history.request('media:history', { event: 'close', sessionId: id }).catch(() => {})
        return
      }
      if (result?.ok) { this.historySession = id; this.pendingResume = result.position }
    }
    this.element.src = source
    this.update({ ...initialState(), source, status: PlayerStatus.LOADING })
    this.element.load()
    void this.loadChapters(location, generation)
    if (this.autoplay && !this.history) await this.play(false)
  }

  async loadChapters(location, generation) {
    if (!this.chapterMetadata || !location?.path) return
    try {
      const response = await this.chapterMetadata(location)
      if (!this.closed && generation === this.sourceGeneration) {
        this.update({ chapters: response?.ok ? response.chapters : [] })
      }
    } catch {
      // Missing/unsupported metadata must never prevent HTML playback.
    }
  }

  async flushHistory(event) {
    if (!this.historySession || (!this.historyReady && event !== 'close')) return
    const payload = { event, sessionId: this.historySession,
      position: this.historyReady ? this.element.currentTime || 0 : 0,
      duration: this.historyReady && Number.isFinite(this.element.duration) ? this.element.duration : 0 }
    return this.history.request('media:history', payload).catch((error) => console.warn('Media history unavailable', error))
  }
  finishRestore(restored) {
    if (this.closed || this.historyReady) return
    clearTimeout(this.restoreTimer)
    this.pendingResume = null
    this.historyReady = true
    this.update({ currentTime: this.element.currentTime || 0 })
    if (restored) this.showOsd('resume')
    if (this.autoplay) void this.play(false).catch(() => {})
  }
  showOsd(kind) {
    this.update({ osd: { id: createPlayerSessionId(), kind, currentTime: this.element.currentTime || 0,
      duration: Number.isFinite(this.element.duration) ? this.element.duration : 0, createdAt: Date.now() } })
  }
  expectAction(kind) { this.explicitAction = kind }
  confirmAction(kind) {
    if (this.explicitAction === kind) { this.explicitAction = null; this.showOsd(kind) }
  }
  async play(explicit = true) {
    if (explicit) this.expectAction('play')
    try { await this.element.play(); if (explicit && !this.element.paused) this.confirmAction('play') }
    catch (error) { this.explicitAction = null; throw error }
  }

  pause() {
    this.autoplay = false
    this.expectAction('pause')
    this.element.pause()
    if (this.element.paused) this.confirmAction('pause')
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
    this.explicitAction = null
    this.element.pause()
    this.seek(0)
  }

  close() {
    if (this.state.status === PlayerStatus.CLOSED) return
    this.closed = true
    this.sourceGeneration++
    clearTimeout(this.restoreTimer)
    this.explicitAction = null
    void this.flushHistory('close')
    this.historySession = null
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.update({ ...initialState(), status: PlayerStatus.CLOSED })
    this.listeners.clear()
  }
}

export class NativeMpvPlayerBackend extends MediaPlayerBackend {
  constructor({ kind = 'video', historyEnabled = true, autoplay = false, transport = backend, sessionId = null } = {}) {
    super()
    this.autoplay = autoplay
    this.kind = kind
    this.historyEnabled = historyEnabled
    this.transport = transport
    this.sessionId = sessionId || createPlayerSessionId()
    this.hasOpenedSession = Boolean(sessionId)
    this.closed = false
    this.sourceGeneration = 0
    this.seekRevision = 0
    this.seekTimer = null
    this.unsubscribe = this.transport.subscribe('player:state', (state) => {
      if (!state || this.closed || !this.sessionId || state.sessionId !== this.sessionId) return
      if (this.state.status === PlayerStatus.CLOSING) return
      this.update({
        status: state.status || this.state.status,
        endedRevision: state.endedRevision ?? this.state.endedRevision,
        currentTime: state.currentTime ?? this.state.currentTime,
        seeking: state.seeking ?? this.state.seeking,
        duration: state.duration ?? this.state.duration,
        volume: state.volume ?? this.state.volume,
        muted: state.muted ?? this.state.muted,
        subtitleDelay: state.subtitleDelay ?? this.state.subtitleDelay,
        tracks: state.tracks || this.state.tracks,
        chapters: state.chapters ?? this.state.chapters,
        tags: state.tags ?? this.state.tags,
        live: state.live ?? this.state.live,
        diagnostics: state.diagnostics ?? this.state.diagnostics,
        osd: state.osd ?? this.state.osd,
        error: state.error ? { message: state.error } : null,
      })
    })
  }

  update(next) {
    if (this.state.pendingSeekTime != null && next.currentTime != null && next.seeking === false && Math.abs(next.currentTime - this.state.pendingSeekTime) <= 1) {
      clearTimeout(this.seekTimer)
      next = { ...next, pendingSeekTime: null }
    }
    if (next.endedRevision != null) next = { ...next, endedRevision: Math.max(this.state.endedRevision || 0, next.endedRevision) }
    super.update(next)
  }

  async request(eventName, payload = {}, { fatal = true } = {}) {
    if (!this.sessionId) throw new Error('Native player session is not attached')
    const sessionId = this.sessionId
    const sourceGeneration = this.sourceGeneration
    console.info(`[player=${sessionId}] command sent: ${eventName}`)
    let response
    try {
      response = await this.transport.request(eventName, { ...payload, sessionId })
    } catch (error) {
      if (this.closed || sessionId !== this.sessionId || sourceGeneration !== this.sourceGeneration) return
      throw error
    }
    // close can finish while a native open/seek response is still in flight.
    if (this.closed || sessionId !== this.sessionId || sourceGeneration !== this.sourceGeneration) return response
    if (!response?.ok) {
      const error = response?.error || { message: 'Native media playback failed' }
      if (fatal) this.update({ status: PlayerStatus.ERROR, error })
      throw Object.assign(new Error(error.message), error)
    }
    if (response.state) this.update(response.state)
    return response
  }

  async setSource(source, geometry) {
    if (this.closed) return
    const sourceGeneration = ++this.sourceGeneration
    clearTimeout(this.seekTimer)
    this.seekRevision++
    if (this.hasOpenedSession) await this.closeSession()
    if (this.closed || sourceGeneration !== this.sourceGeneration) return
    if (!this.sessionId) this.sessionId = createPlayerSessionId()
    const logical = normalizeMediaSource(source)
    const sourceKey = logical.sourceType === 'url' ? mediaIdentity(logical) : `${logical.providerId}:${logical.path}`
    console.info(`[player=${this.sessionId}] source selected: ${logical.sourceType}`)
    console.info(`[player=${this.sessionId}] native open requested`)
    this.state.endedRevision = 0
    this.update({ ...initialState(), pendingSeekTime: null, source: sourceKey, status: PlayerStatus.OPENING })
    const sessionId = this.sessionId
    // An opening session already owns native resources. A source switch must
    // cancel it too, rather than sending a second open with the same identity.
    this.hasOpenedSession = true
    const response = await this.request('player:open', {
      ...logical,
      ...(logical.sourceType === 'provider' ? { filesystemId: logical.providerId } : {}),
      autoplay: this.autoplay,
      kind: this.kind,
      historyEnabled: logical.sourceType !== 'url' && this.historyEnabled,
      ...(this.kind === 'video' ? { geometry } : {}),
    })
    if (this.closed || sessionId !== this.sessionId || sourceGeneration !== this.sourceGeneration) return
    if (response.sessionId !== this.sessionId) {
      throw new Error(`Native player returned a different session id: ${response.sessionId || 'none'}`)
    }
    this.hasOpenedSession = true
    console.info(`[player=${this.sessionId}] native open returned`)
  }

  canSendPlaybackCommand() {
    return [PlayerStatus.READY, PlayerStatus.PLAYING, PlayerStatus.PAUSED].includes(this.state.status)
  }

  command(eventName, payload = {}) {
    if (!this.canSendPlaybackCommand()) {
      console.info(`[player=${this.sessionId}] command blocked while state=${this.state.status}: ${eventName}`)
      return Promise.resolve({ ok: false, skipped: true })
    }
    return this.request(eventName, payload)
  }

  play() { return this.command('player:play') }
  pause() {
    this.autoplay = false
    if (this.hasOpenedSession && [PlayerStatus.OPENING, PlayerStatus.LOADING].includes(this.state.status)) {
      return this.request('player:pause', {}, { fatal: false }).catch(() => ({ ok: true, pending: true }))
    }
    return this.command('player:pause')
  }
  async seek(seconds) {
    if (!this.canSendPlaybackCommand()) return { ok: false, skipped: true }
    const revision = ++this.seekRevision
    const target = Math.max(0, Math.min(this.state.duration, Number(seconds) || 0))
    clearTimeout(this.seekTimer)
    this.update({ pendingSeekTime: target })
    this.seekTimer = setTimeout(() => { if (revision === this.seekRevision) this.update({ pendingSeekTime: null }) }, 10000)
    try { const result = await this.request('player:seek', { seconds: target }, { fatal: false }); if (revision === this.seekRevision) { clearTimeout(this.seekTimer); this.update({ pendingSeekTime: null }) }; return result }
    catch (error) { if (revision === this.seekRevision) { clearTimeout(this.seekTimer); this.update({ pendingSeekTime: null }) }; throw error }
  }
  setVolume(volume) { return this.command('player:set-volume', { volume: Math.max(0, Math.min(1, Number(volume) || 0)) }) }
  setMuted(muted) { return this.command('player:set-muted', { muted: Boolean(muted) }) }
  selectTrack(kind, id) { return this.command('player:select-track', { kind, id }) }
  setSubtitleDelay(seconds) { return this.command('player:set-subtitle-delay', { seconds: Number(seconds) || 0 }) }
  setGeometry(geometry) { return this.kind === 'audio' ? Promise.resolve({ ok: true, skipped: true }) : this.request('player:set-geometry', { geometry }, { fatal: false }) }
  setVisible(visible) { return this.kind === 'audio' ? Promise.resolve({ ok: true, skipped: true }) : this.request('player:set-visible', { visible: Boolean(visible) }, { fatal: false }) }
  setOverlay(visible, geometry, context = {}) {
    if (this.kind === 'audio') return Promise.resolve({ ok: true, skipped: true })
    return this.request('player:set-overlay', { visible: Boolean(visible), geometry, context }, { fatal: false })
  }
  refresh() { return this.request('player:snapshot') }
  overlaySnapshot() { return this.request('player:overlay-snapshot') }
  stop() { return this.pause().then(() => this.seek(0)) }

  dispose() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.seekTimer)
    this.unsubscribe?.()
    this.listeners.clear()
  }

  async closeSession() {
    if (!this.sessionId) return
    const sessionId = this.sessionId
    console.info(`[player=${sessionId}] close requested`)
    this.update({ status: PlayerStatus.CLOSING })
    await this.transport.request('player:close', { sessionId })
    if (this.sessionId === sessionId) {
      this.sessionId = null
      this.hasOpenedSession = false
    }
  }

  close() {
    if (this.closed) return
    void this.closeSession()
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

// The native transition cover belongs to the main window, not to a player
// session, so a closing viewer can still remove it. Resolves after the fade
// with `false` when this platform has no native cover.
export const setNativeTransitionCover = async (covered, durationMs = 0) => {
  if (backendRuntimeMode !== 'tauri') return false
  const response = await backend.request('player:set-transition-cover', {
    covered: Boolean(covered),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
  })
  if (!response?.ok) throw new Error(response?.error?.message || 'Native transition cover failed')
  return Boolean(response.native)
}

export const selectPlayerBackend = async (kind = 'video', {
  runtimeMode = backendRuntimeMode, capabilities = getNativePlayerCapabilities,
} = {}) => {
  if (runtimeMode !== 'tauri') return 'web'
  const native = await capabilities()
  return native.available && (kind === 'audio' || native.renderApi) ? 'mpv' : 'web'
}
