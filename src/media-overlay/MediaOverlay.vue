<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { mediaOverlay } from '../api/mediaOverlay.js'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
} from '../player/mediaPlayerBackend.js'

const context = reactive({
  title: '',
  position: 0,
  total: 0,
  fullscreen: false,
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
const audioTracks = computed(() => state.tracks.filter((track) => track.kind === 'audio'))
const subtitleTracks = computed(() => state.tracks.filter((track) => track.kind === 'subtitle'))
const diagnostics = computed(() => state.diagnostics)
let player = null
let unsubscribeState = null
let unsubscribeContext = null
let controlsTimer = 0

const applyState = (snapshot) => Object.assign(state, snapshot || {})
const applyContext = (value) => Object.assign(context, value || {})
const formatTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const remainder = Math.floor(value % 60)
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}
const formatBytes = (bytes) => {
  const value = Number(bytes) || 0
  if (!value) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / (1024 ** index)).toFixed(index > 2 ? 2 : 1)} ${units[index]}`
}
const formatBitrate = (bitsPerSecond) => {
  const value = Number(bitsPerSecond) || 0
  if (!value) return 'unknown'
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)} Mbps`
    : `${Math.round(value / 1000)} kbps`
}
const clearControlsTimer = () => {
  window.clearTimeout(controlsTimer)
  controlsTimer = 0
}
const scheduleControlsHide = () => {
  clearControlsTimer()
  if (!isPlaying.value || activeMenu.value) return
  controlsTimer = window.setTimeout(() => { controlsVisible.value = false }, 2750)
}
const showControls = () => {
  controlsVisible.value = true
  scheduleControlsHide()
}
const toggleMenu = (menu) => {
  activeMenu.value = activeMenu.value === menu ? '' : menu
}
const closeMenu = () => { activeMenu.value = '' }
const togglePlay = () => isPlaying.value ? player?.pause() : player?.play()
const selectTrack = async (kind, id) => {
  await player?.selectTrack(kind, id).catch(() => {})
  closeMenu()
}
const sendAction = (action) => mediaOverlay.sendAction(action)
const handlePointerDown = (event) => {
  if (!activeMenu.value) return
  if (event.target?.closest?.('.media-overlay-dropdown, .media-overlay-info')) return
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

watch([isPlaying, activeMenu], ([playing, menu]) => {
  if (!playing || menu) {
    clearControlsTimer()
    controlsVisible.value = true
  } else {
    scheduleControlsHide()
  }
})

onMounted(async () => {
  player = new NativeMpvPlayerBackend()
  unsubscribeState = player.subscribe(applyState)
  unsubscribeContext = mediaOverlay.onContext(applyContext)
  document.addEventListener('pointerdown', handlePointerDown, true)
  document.addEventListener('keydown', handleKeydown)
  const [snapshot, overlay] = await Promise.all([
    player.refresh().catch(() => null),
    player.overlaySnapshot().catch(() => null),
  ])
  if (snapshot?.state) applyState(snapshot.state)
  if (overlay?.context) applyContext(overlay.context)
})

onBeforeUnmount(() => {
  clearControlsTimer()
  document.removeEventListener('pointerdown', handlePointerDown, true)
  document.removeEventListener('keydown', handleKeydown)
  unsubscribeContext?.()
  unsubscribeState?.()
  player?.dispose()
})
</script>

<template>
  <main
    class="media-overlay"
    :class="{ 'is-fullscreen': context.fullscreen, 'is-controls-hidden': !controlsVisible }"
    @pointermove="showControls"
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
          <section>
            <h2>General</h2>
            <dl>
              <div><dt>Container</dt><dd>{{ diagnostics.container || 'unknown' }}</dd></div>
              <div><dt>File size</dt><dd>{{ formatBytes(diagnostics.fileSize) }}</dd></div>
              <div><dt>Duration</dt><dd>{{ formatTime(diagnostics.duration || state.duration) }}</dd></div>
              <div><dt>Average bitrate</dt><dd>{{ formatBitrate(diagnostics.overallBitrate) }}</dd></div>
            </dl>
          </section>
          <section>
            <h2>Video</h2>
            <dl>
              <div><dt>Format</dt><dd>{{ diagnostics.video?.friendlyCodec || diagnostics.video?.codec || 'unknown' }}<span v-if="diagnostics.video?.profile"> · {{ diagnostics.video.profile }}</span><span v-if="diagnostics.video?.level">@{{ diagnostics.video.level }}</span></dd></div>
              <div><dt>Picture</dt><dd>{{ diagnostics.video?.width || '?' }}×{{ diagnostics.video?.height || '?' }}<span v-if="diagnostics.video?.frameRate"> · {{ Number(diagnostics.video.frameRate).toFixed(3) }} fps</span><span v-if="diagnostics.video?.progressive != null"> · {{ diagnostics.video.progressive ? 'Progressive' : 'Interlaced' }}</span></dd></div>
              <div><dt>Signal</dt><dd><span v-if="diagnostics.bitDepth">{{ diagnostics.bitDepth }}-bit · </span>{{ diagnostics.video?.chroma || diagnostics.pixelFormat || 'unknown' }} · {{ diagnostics.sourceFormat || 'SDR' }}</dd></div>
              <div><dt>Color</dt><dd>{{ diagnostics.primaries || 'unknown' }} · {{ diagnostics.video?.matrix || 'unknown' }} · {{ diagnostics.transfer || 'unknown' }}</dd></div>
              <div v-if="diagnostics.video?.bitrate"><dt>Stream bitrate</dt><dd>{{ formatBitrate(diagnostics.video.bitrate) }}</dd></div>
            </dl>
          </section>
          <section>
            <h2>Current audio</h2>
            <dl>
              <div><dt>Format</dt><dd>{{ diagnostics.audio?.friendlyCodec || diagnostics.audio?.codec || 'unknown' }}<span v-if="diagnostics.audio?.channels"> · {{ diagnostics.audio.channels }}</span></dd></div>
              <div><dt>Audio</dt><dd><span v-if="diagnostics.audio?.bitrate">{{ formatBitrate(diagnostics.audio.bitrate) }} · </span><span v-if="diagnostics.audio?.sampleRate">{{ Math.round(diagnostics.audio.sampleRate / 1000) }} kHz</span></dd></div>
              <div v-if="diagnostics.audio?.language || diagnostics.audio?.title"><dt>Track</dt><dd>{{ diagnostics.audio.language || 'und' }}<span v-if="diagnostics.audio.title"> · {{ diagnostics.audio.title }}</span></dd></div>
            </dl>
          </section>
          <section v-if="diagnostics.subtitle?.format">
            <h2>Subtitle</h2>
            <dl>
              <div><dt>Format</dt><dd>{{ diagnostics.subtitle.format }}</dd></div>
              <div><dt>Track</dt><dd>{{ diagnostics.subtitle.language || 'und' }}<span v-if="diagnostics.subtitle.title"> · {{ diagnostics.subtitle.title }}</span><span v-if="diagnostics.subtitle.forced"> · Forced</span><span v-if="diagnostics.subtitle.default"> · Default</span></dd></div>
            </dl>
          </section>
          <section>
            <h2>Playback</h2>
            <dl>
              <div><dt>Backend / demuxer</dt><dd>libmpv · FFmpeg / {{ diagnostics.container || 'unknown' }}</dd></div>
              <div><dt>Decoder</dt><dd>{{ diagnostics.hardwareDecoder || diagnostics.decoder || 'FFmpeg software' }} · Hardware decode {{ diagnostics.hardwareDecoder ? 'active' : 'off' }}</dd></div>
              <div><dt>Render surface</dt><dd>{{ diagnostics.renderer }}</dd></div>
              <div><dt>Output</dt><dd>{{ diagnostics.outputMode }} · {{ diagnostics.outputColorSpace }}</dd></div>
              <div><dt>Tone mapping</dt><dd>{{ diagnostics.toneMapping }}</dd></div>
              <div><dt>Display</dt><dd>{{ Number(diagnostics.display?.currentHeadroom || 1).toFixed(2) }}× current / {{ Number(diagnostics.display?.potentialHeadroom || 1).toFixed(2) }}× potential · {{ diagnostics.display?.surfaceFormat }}</dd></div>
              <div v-if="diagnostics.fallbackReason"><dt>Fallback reason</dt><dd>{{ diagnostics.fallbackReason }}</dd></div>
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
                  {{ track.title || track.language || `Track ${track.id}` }}<span v-if="track.codec"> · {{ track.codec }}</span><span v-if="track.channels"> · {{ track.channels }}</span>
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
                  {{ track.title || track.language || `Track ${track.id}` }}<span v-if="track.codec"> · {{ track.codec }}</span>
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

          <button v-if="diagnostics" class="btn btn-sm btn-dark" type="button" :aria-expanded="activeMenu === 'diagnostics'" @click="toggleMenu('diagnostics')">Info</button>
          <button class="media-overlay-control-button" type="button" :title="context.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" :aria-label="context.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" @click="sendAction('fullscreen')">
            <i class="mdi" :class="context.fullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'" aria-hidden="true" />
          </button>
        </div>
        <input class="form-range media-overlay-seek" type="range" min="0" :max="state.duration || 0" step="0.1" :value="state.currentTime" aria-label="Playback position" @input="player?.seek($event.target.value)">
      </div>
    </section>
  </main>
</template>
