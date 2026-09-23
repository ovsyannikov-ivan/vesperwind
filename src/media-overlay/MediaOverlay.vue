<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { mediaOverlay } from '../api/mediaOverlay.js'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
} from '../player/mediaPlayerBackend.js'
import { buildMediaInfoSections, formatMediaDuration } from '../utils/mediaInfo.js'

const context = reactive({
  title: '',
  position: 0,
  total: 0,
  fullscreen: false,
  borderRadius: 0,
})
const state = reactive({
  status: PlayerStatus.IDLE,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  subtitleDelay: 0,
  tracks: [],
  diagnostics: null,
  error: null,
})
const activeMenu = ref('')
const controlsVisible = ref(true)
const isPlaying = computed(() => state.status === PlayerStatus.PLAYING)
const isCursorHidden = computed(() => (
  isPlaying.value
  && !controlsVisible.value
  && !activeMenu.value
  && !state.error
))
const audioTracks = computed(() => state.tracks.filter((track) => track.kind === 'audio'))
const subtitleTracks = computed(() => state.tracks.filter((track) => track.kind === 'subtitle'))
const diagnostics = computed(() => state.diagnostics)
const infoSections = computed(() => buildMediaInfoSections(diagnostics.value, state.duration))
let player = null
let unsubscribeState = null
let unsubscribeContext = null
let controlsTimer = 0

const applyState = (snapshot) => Object.assign(state, snapshot || {})
const attachToSession = async (sessionId) => {
  if (!sessionId || player?.sessionId === sessionId) return
  unsubscribeState?.()
  player?.dispose()
  player = new NativeMpvPlayerBackend({ sessionId })
  unsubscribeState = player.subscribe(applyState)
  console.info(`[player=${sessionId}] overlay mounted`)
  console.info(`[player=${sessionId}] overlay attached to session`)
  const snapshot = await player.refresh().catch(() => null)
  if (snapshot?.state) applyState(snapshot.state)
}
const applyContext = (value) => {
  Object.assign(context, value || {})
  if (value?.sessionId) void attachToSession(value.sessionId)
}
const formatTime = formatMediaDuration
const clearControlsTimer = () => {
  window.clearTimeout(controlsTimer)
  controlsTimer = 0
}
const scheduleControlsHide = () => {
  clearControlsTimer()
  if (!isPlaying.value || activeMenu.value) return
  controlsTimer = window.setTimeout(() => { controlsVisible.value = false }, 2750)
}
const restoreControls = () => {
  clearControlsTimer()
  controlsVisible.value = true
}
const showControls = () => {
  controlsVisible.value = true
  scheduleControlsHide()
}
const toggleMenu = (menu) => {
  activeMenu.value = activeMenu.value === menu ? '' : menu
}
const closeMenu = () => { activeMenu.value = '' }
const trackChannelLabel = (track) => track.channelLayout || (track.channels ? `${track.channels} channels` : '')
const togglePlay = () => isPlaying.value ? player?.pause() : player?.play()
const selectTrack = async (kind, id) => {
  await player?.selectTrack(kind, id).catch(() => {})
  closeMenu()
}
const sendAction = (action) => mediaOverlay.sendAction(action)
const handlePointerDown = (event) => {
  showControls()
  if (!activeMenu.value) return
  if (event.target?.closest?.('.media-overlay-dropdown, .media-overlay-info, .media-overlay-info-toggle')) return
  closeMenu()
}
const handleKeydown = (event) => {
  showControls()
  if (event.key === 'Escape') {
    event.preventDefault()
    if (activeMenu.value) closeMenu()
    else if (context.fullscreen) void sendAction('fullscreen')
    else void sendAction('close')
  } else if (event.key === 'ArrowLeft' && context.total > 1 && !activeMenu.value) {
    event.preventDefault()
    void sendAction('previous')
  } else if (event.key === 'ArrowRight' && context.total > 1 && !activeMenu.value) {
    event.preventDefault()
    void sendAction('next')
  } else if (event.key === ' ' && !activeMenu.value) {
    event.preventDefault()
    void togglePlay()
  }
}

watch([isPlaying, activeMenu, () => state.error], ([playing, menu, error]) => {
  if (!playing || menu || error) {
    restoreControls()
  } else {
    scheduleControlsHide()
  }
})

watch(() => context.fullscreen, () => showControls())

onMounted(async () => {
  unsubscribeContext = mediaOverlay.onContext(applyContext)
  document.addEventListener('pointerdown', handlePointerDown, true)
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('wheel', showControls, { passive: true })
  document.addEventListener('touchstart', showControls, { passive: true })
  const overlay = await mediaOverlay.snapshot().catch(() => null)
  if (overlay?.context?.sessionId) applyContext(overlay.context)
})

onBeforeUnmount(() => {
  clearControlsTimer()
  controlsVisible.value = true
  document.removeEventListener('pointerdown', handlePointerDown, true)
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('wheel', showControls)
  document.removeEventListener('touchstart', showControls)
  unsubscribeContext?.()
  unsubscribeState?.()
  player?.dispose()
})
</script>

<template>
  <main
    class="media-overlay"
    :class="{ 'is-fullscreen': context.fullscreen, 'is-controls-hidden': !controlsVisible, 'is-cursor-hidden': isCursorHidden }"
    :style="{ '--overlay-border-radius': `${Math.max(0, Number(context.borderRadius) || 0)}px` }"
    @pointermove="showControls"
    @pointerleave="restoreControls"
  >
    <header v-if="!context.fullscreen" class="media-overlay-header">
      <h1 class="media-overlay-title">
        <i class="mdi mdi-movie-open-play-outline" aria-hidden="true" />
        <span class="text-truncate">{{ context.title }}</span>
        <span v-if="context.total > 1" class="media-overlay-position">{{ context.position }} / {{ context.total }}</span>
      </h1>
      <button class="media-overlay-header-button" type="button" title="Enter fullscreen" aria-label="Enter fullscreen" @click="sendAction('fullscreen')">
        <i class="mdi mdi-fullscreen" aria-hidden="true" />
      </button>
      <button class="btn-close btn-close-white" type="button" aria-label="Close" @click="sendAction('close')" />
    </header>

    <section class="media-overlay-stage" @dblclick="sendAction('fullscreen')">
      <div v-if="state.error" class="alert alert-danger media-overlay-error" role="alert">
        {{ state.error.message || state.error }}
      </div>
      <button
        v-if="context.fullscreen"
        class="media-overlay-fullscreen-close"
        :class="{ 'is-hidden': !controlsVisible }"
        type="button"
        title="Exit fullscreen"
        aria-label="Exit fullscreen"
        @click.stop="sendAction('fullscreen')"
      >
        <i class="mdi mdi-close" aria-hidden="true" />
      </button>

      <template v-if="context.total > 1">
        <button
          class="media-overlay-navigation is-previous"
          :class="{ 'is-hidden': !controlsVisible }"
          type="button"
          title="Previous item (Left arrow)"
          aria-label="Previous item"
          @click.stop="sendAction('previous')"
        >
          <i class="mdi mdi-chevron-left" aria-hidden="true" />
        </button>
        <button
          class="media-overlay-navigation is-next"
          :class="{ 'is-hidden': !controlsVisible }"
          type="button"
          title="Next item (Right arrow)"
          aria-label="Next item"
          @click.stop="sendAction('next')"
        >
          <i class="mdi mdi-chevron-right" aria-hidden="true" />
        </button>
      </template>

      <div class="media-overlay-controls" :class="{ 'is-hidden': !controlsVisible }" @dblclick.stop>
        <div v-if="activeMenu === 'diagnostics' && diagnostics" class="media-overlay-info">
          <section v-for="section in infoSections" :key="section.title">
            <h2>{{ section.title }}</h2>
            <dl>
              <div v-for="item in section.rows" :key="item.label">
                <dt>{{ item.label }}</dt>
                <dd :title="item.title || undefined">{{ item.value }}</dd>
              </div>
            </dl>
          </section>
        </div>

        <div class="media-overlay-controls-main">
          <button class="media-overlay-control-button" type="button" :title="isPlaying ? 'Pause' : 'Play'" :aria-label="isPlaying ? 'Pause' : 'Play'" @click="togglePlay">
            <i class="mdi" :class="isPlaying ? 'mdi-pause' : 'mdi-play'" aria-hidden="true" />
          </button>
          <span class="media-overlay-time">{{ formatTime(state.currentTime) }} / {{ formatTime(state.duration) }}</span>
          <button class="media-overlay-control-button" type="button" :title="state.muted ? 'Unmute' : 'Mute'" :aria-label="state.muted ? 'Unmute' : 'Mute'" @click="player?.setMuted(!state.muted)">
            <i class="mdi" :class="state.muted ? 'mdi-volume-off' : 'mdi-volume-high'" aria-hidden="true" />
          </button>
          <input class="form-range media-overlay-volume" type="range" min="0" max="1" step="0.01" :value="state.volume" aria-label="Volume" @input="player?.setVolume($event.target.value)">
          <span class="media-overlay-spacer" />

          <div v-if="audioTracks.length" class="dropup media-overlay-dropdown">
            <button class="btn btn-sm btn-dark dropdown-toggle" type="button" :aria-expanded="activeMenu === 'audio'" @click="toggleMenu('audio')">Audio</button>
            <ul v-if="activeMenu === 'audio'" class="dropdown-menu dropdown-menu-dark show">
              <li v-for="track in audioTracks" :key="track.id">
                <button class="dropdown-item" :class="{ active: track.selected }" type="button" @click="selectTrack('audio', track.id)">
                  {{ track.title || track.friendlyLanguage || track.language || `Track ${track.id}` }}<span v-if="track.friendlyCodec || track.codec"> · {{ track.friendlyCodec || track.codec }}</span><span v-if="trackChannelLabel(track)"> · {{ trackChannelLabel(track) }}</span>
                </button>
              </li>
            </ul>
          </div>

          <div v-if="subtitleTracks.length" class="dropup media-overlay-dropdown">
            <button class="btn btn-sm btn-dark dropdown-toggle" type="button" :aria-expanded="activeMenu === 'subtitle'" @click="toggleMenu('subtitle')">Subtitles</button>
            <ul v-if="activeMenu === 'subtitle'" class="dropdown-menu dropdown-menu-dark show">
              <li><button class="dropdown-item" :class="{ active: !subtitleTracks.some((track) => track.selected) }" type="button" @click="selectTrack('subtitle', null)">Off</button></li>
              <li v-for="track in subtitleTracks" :key="track.id">
                <button class="dropdown-item" :class="{ active: track.selected }" type="button" @click="selectTrack('subtitle', track.id)">
                  {{ track.title || track.friendlyLanguage || track.language || `Track ${track.id}` }}<span v-if="track.friendlyCodec || track.codec"> · {{ track.friendlyCodec || track.codec }}</span>
                </button>
              </li>
              <li><hr class="dropdown-divider"></li>
              <li class="media-overlay-delay-item">
                <label>Delay
                  <input class="form-range" type="range" min="-10" max="10" step="0.1" :value="state.subtitleDelay" @input="player?.setSubtitleDelay($event.target.value)">
                  <span>{{ Number(state.subtitleDelay).toFixed(1) }}s</span>
                </label>
              </li>
            </ul>
          </div>

          <button v-if="diagnostics" class="btn btn-sm btn-dark media-overlay-info-toggle" type="button" :aria-expanded="activeMenu === 'diagnostics'" @click="toggleMenu('diagnostics')">Info</button>
          <button class="media-overlay-control-button" type="button" :title="context.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" :aria-label="context.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" @click="sendAction('fullscreen')">
            <i class="mdi" :class="context.fullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'" aria-hidden="true" />
          </button>
        </div>
        <input class="form-range media-overlay-seek" type="range" min="0" :max="state.duration || 0" step="0.1" :value="state.currentTime" aria-label="Playback position" @input="player?.seek($event.target.value)">
      </div>
    </section>
  </main>
</template>
