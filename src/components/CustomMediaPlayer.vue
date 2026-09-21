<script setup>
import 'media-chrome/dist/media-controller.js'
import 'media-chrome/dist/media-control-bar.js'
import 'media-chrome/dist/media-loading-indicator.js'
import 'media-chrome/dist/media-mute-button.js'
import 'media-chrome/dist/media-pip-button.js'
import 'media-chrome/dist/media-play-button.js'
import 'media-chrome/dist/media-playback-rate-button.js'
import 'media-chrome/dist/media-time-display.js'
import 'media-chrome/dist/media-time-range.js'
import 'media-chrome/dist/media-volume-range.js'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
  WebMediaPlayerBackend,
  selectPlayerBackend,
} from '../player/mediaPlayerBackend.js'

const props = defineProps({
  src: { type: String, required: true },
  providerId: { type: String, default: 'local' },
  path: { type: String, default: '' },
  kind: {
    type: String,
    required: true,
    validator: (value) => ['audio', 'video'].includes(value),
  },
  autoplay: { type: Boolean, default: false },
  fullscreen: { type: Boolean, default: false },
  title: { type: String, default: '' },
  position: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
})

const emit = defineEmits(['error', 'fullscreen', 'backend'])
const mediaElement = ref(null)
const nativeSurface = ref(null)
const backendMode = ref('loading')
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
const isAudio = computed(() => props.kind === 'audio')
const isNative = computed(() => backendMode.value === 'mpv')
let player = null
let unsubscribeState = null
let resizeObserver = null
let geometryFrame = 0
let generation = 0

const geometry = () => {
  const rect = nativeSurface.value?.getBoundingClientRect()
  return rect ? {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scaleFactor: window.devicePixelRatio || 1,
    viewportHeight: window.innerHeight,
  } : { x: 0, y: 0, width: 1, height: 1, scaleFactor: window.devicePixelRatio || 1, viewportHeight: window.innerHeight }
}

const overlayGeometry = () => {
  if (props.fullscreen) {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  }
  const rect = nativeSurface.value?.closest('.modal-content')?.getBoundingClientRect()
  return rect ? {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  } : { x: 0, y: 0, width: 1, height: 1 }
}

const overlayContext = () => ({
  title: props.title,
  position: props.position,
  total: props.total,
  fullscreen: props.fullscreen,
})

const syncGeometry = () => {
  if (!isNative.value || !player || !nativeSurface.value) return
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    void Promise.all([
      player?.setGeometry(geometry()),
      player?.setOverlay(true, overlayGeometry(), overlayContext()),
    ]).catch(() => {})
  })
}

const syncOverlayContext = () => {
  if (!isNative.value || !player) return
  void player.setOverlay(true, overlayGeometry(), overlayContext()).catch(() => {})
}

const handleLayoutSettled = () => syncGeometry()

const attachNativeGeometry = () => {
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(syncGeometry)
  resizeObserver.observe(nativeSurface.value)
  window.addEventListener('resize', syncGeometry)
  document.addEventListener('shown.bs.modal', handleLayoutSettled)
  document.addEventListener('transitionend', handleLayoutSettled)
  syncGeometry()
}

const applyState = (snapshot) => {
  Object.assign(state, snapshot)
  if (snapshot.error) emit('error', snapshot.error)
}

const sourceLocation = () => ({ providerId: props.providerId || 'local', path: props.path })

const createPlayer = async () => {
  const currentGeneration = ++generation
  const mode = props.kind === 'video' ? await selectPlayerBackend() : 'web'
  if (currentGeneration !== generation) return
  backendMode.value = mode
  emit('backend', mode)
  await nextTick()
  if (mode === 'mpv') {
    player = new NativeMpvPlayerBackend({ autoplay: props.autoplay })
    unsubscribeState = player.subscribe(applyState)
    attachNativeGeometry()
    await player.setSource(sourceLocation(), geometry())
    await player.setOverlay(true, overlayGeometry(), overlayContext())
  } else {
    player = new WebMediaPlayerBackend(mediaElement.value, { autoplay: props.autoplay })
    unsubscribeState = player.subscribe(applyState)
    await player.setSource(props.src)
  }
}

const pause = () => player?.pause()
const play = () => player?.play()
const seek = (seconds) => player?.seek(seconds)
const stop = () => player?.stop()

onMounted(() => void createPlayer().catch((error) => emit('error', error)))

watch(
  () => [props.src, props.providerId, props.path],
  () => {
    if (!player) return
    const request = isNative.value
      ? player.setSource(sourceLocation(), geometry())
      : player.setSource(props.src)
    void request.catch((error) => emit('error', error))
  },
)

watch(
  () => props.fullscreen,
  async () => {
    await nextTick()
    syncGeometry()
  },
)


watch(
  () => [props.title, props.position, props.total],
  () => syncOverlayContext(),
)

onBeforeUnmount(() => {
  generation += 1
  cancelAnimationFrame(geometryFrame)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', syncGeometry)
  document.removeEventListener('shown.bs.modal', handleLayoutSettled)
  document.removeEventListener('transitionend', handleLayoutSettled)
  unsubscribeState?.()
  player?.close()
  player = null
})

defineExpose({ mediaElement, pause, play, seek, stop })
</script>

<template>
  <div v-if="isNative" class="custom-media-player native-mpv-player is-video">
    <div ref="nativeSurface" class="native-mpv-surface" aria-label="Native video surface">
      <span v-if="state.status === PlayerStatus.LOADING" class="spinner-border text-light" aria-label="Loading video" />
    </div>
  </div>

  <media-controller
    v-else
    class="custom-media-player"
    :class="isAudio ? 'is-audio' : 'is-video'"
    :audio="isAudio || undefined"
  >
    <audio v-if="isAudio" ref="mediaElement" slot="media" :autoplay="autoplay" preload="metadata" @error="emit('error')" />
    <video v-else ref="mediaElement" slot="media" :autoplay="autoplay" playsinline preload="metadata" @error="emit('error')" />
    <media-loading-indicator v-if="!isAudio" slot="centered-chrome" noautohide />
    <media-play-button v-if="!isAudio" slot="centered-chrome" class="custom-media-player-centered-play" aria-label="Play or pause video" />
    <media-control-bar class="custom-media-player-controls">
      <media-play-button aria-label="Play or pause" />
      <media-time-display showduration />
      <media-time-range aria-label="Playback position" />
      <media-mute-button aria-label="Mute or unmute" />
      <media-volume-range aria-label="Volume" />
      <media-playback-rate-button v-if="!isAudio" />
      <media-pip-button v-if="!isAudio" />
      <button v-if="!isAudio" class="media-control-button" type="button" title="Enter fullscreen" aria-label="Enter fullscreen" @click="emit('fullscreen')"><i class="mdi mdi-fullscreen" aria-hidden="true" /></button>
    </media-control-bar>
  </media-controller>
</template>
