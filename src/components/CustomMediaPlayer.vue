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
import ChapterControls from './ChapterControls.vue'
import MediaOsd from './MediaOsd.vue'
import { createMediaOsd } from '../player/mediaOsd.js'
import ThumbnailPreview from './ThumbnailPreview.vue'
import { useThumbnailPreview } from '../composables/useThumbnailPreview.js'
import { createSeekController, canHandleSeekKey } from '../player/seekController.js'
import { mediaOverlay } from '../api/mediaOverlay.js'
import { createLayoutQueue } from '../player/layoutQueue.js'
import { waitForNativeGeometry } from '../player/nativeGeometry.js'
import {
  NativeMpvPlayerBackend,
  PlayerStatus,
  WebMediaPlayerBackend,
  selectPlayerBackend,
  setNativeTransitionCover,
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
  historyEnabled: { type: Boolean, default: true },
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
  chapters: [],
  currentChapterIndex: null,
  diagnostics: null,
  error: null,
})
const chaptersOpen = ref(false)
const selectChapter = (index) => {
  seekController.reset()
  chaptersOpen.value = false
  return player?.selectChapter(index)?.catch?.((error) => console.warn('Chapter seek failed', error))
}
const chapterStep = (direction) => {
  seekController.reset()
  return (direction < 0 ? player?.previousChapter() : player?.nextChapter())?.catch?.((error) => console.warn('Chapter seek failed', error))
}
const osdMessage = ref(null)
const osd = createMediaOsd({ onChange: (v) => { osdMessage.value = v } })
const seekFeedback = ref(null)
const seekController = createSeekController({
  getTime: () => state.currentTime, getDuration: () => state.duration,
  seek: (target) => player?.seek(target), onChange: (value) => { seekFeedback.value = value },
  onError: (error) => console.warn('Video seek failed', error),
})
const sourceLocation = () => ({ providerId: props.providerId || 'local', path: props.path })
const thumbnail = useThumbnailPreview(() => ({ ...sourceLocation(), sourceHdr: state.diagnostics?.sourceHdr }))
const handleVideoKeydown = (event) => {
  if (isAudio.value || isNative.value || nativeTransitioning || !canHandleSeekKey(event)) return
  if (![PlayerStatus.READY, PlayerStatus.PLAYING, PlayerStatus.PAUSED].includes(state.status)) return
  if (seekController.add(event.key === 'ArrowRight' ? 10 : -10)) {
    event.preventDefault()
    event.stopPropagation()
  }
}
const handlePreview = (event) => {
  if (isAudio.value || event.detail == null) { thumbnail.hide(); return }
  thumbnail.show(event.detail, state.duration > 0 ? event.detail / state.duration : 0)
}
const isAudio = computed(() => props.kind === 'audio')
const isNative = computed(() => backendMode.value === 'mpv')
let player = null
let unsubscribeState = null
let resizeObserver = null
let geometryFrame = 0
let generation = 0
let nativeReady = false
let nativeTransitioning = false
let nativeTransitionGeneration = 0
// The current transition is hidden by the native window cover instead of the
// overlay WebView cover.
let nativeCover = false
const pendingGeometryUpdates = new Set()
const trackGeometryUpdate = (request) => {
  pendingGeometryUpdates.add(request)
  void request.catch(() => {}).finally(() => pendingGeometryUpdates.delete(request))
  return request
}
const layoutQueue = createLayoutQueue({
  apply: async ({ sessionId, video, overlay, context }) => {
    if (!nativeReady || !player || player.sessionId !== sessionId) return
    await player.setGeometry(video)
    await player.setOverlay(true, overlay, context)
  },
  onError: (error) => console.warn('Media layout update failed', error),
})
const viewportGeometry = () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
  scaleFactor: window.devicePixelRatio || 1 })

const modalBorderRadius = () => {
  if (props.fullscreen) return 0
  const modalContent = nativeSurface.value?.closest('.modal-content')
  const value = modalContent
    ? Number.parseFloat(window.getComputedStyle(modalContent).borderTopLeftRadius)
    : 0
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

const subtitlePosition = (height) => {
  if (props.fullscreen) return 100
  const safeHeight = Math.max(1, Number(height) || 1)
  const controlsClearance = 76
  return Math.max(60, Math.min(100, ((safeHeight - controlsClearance) / safeHeight) * 100))
}

const geometry = () => {
  const rect = nativeSurface.value?.getBoundingClientRect()
  return rect ? {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scaleFactor: window.devicePixelRatio || 1,
    viewportHeight: window.innerHeight,
    borderRadius: modalBorderRadius(),
    subtitlePosition: subtitlePosition(rect.height),
  } : { x: 0, y: 0, width: 1, height: 1, scaleFactor: window.devicePixelRatio || 1, viewportHeight: window.innerHeight, borderRadius: 0, subtitlePosition: 100 }
}

const overlayGeometry = () => {
  if (props.fullscreen || nativeTransitioning) {
    return viewportGeometry()
  }
  const rect = nativeSurface.value?.closest('.modal-content')?.getBoundingClientRect()
  return rect ? {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scaleFactor: window.devicePixelRatio || 1,
  } : { x: 0, y: 0, width: 1, height: 1, scaleFactor: window.devicePixelRatio || 1 }
}

const overlayContext = () => ({
  sessionId: player?.sessionId || null,
  title: props.title,
  ...sourceLocation(),
  position: props.position,
  total: props.total,
  fullscreen: props.fullscreen,
  borderRadius: nativeTransitioning ? 0 : modalBorderRadius(),
  transitioning: nativeTransitioning,
})

const syncGeometry = () => {
  if (!isNative.value || !player || !nativeSurface.value || !nativeReady || nativeTransitioning) return
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    if (nativeTransitioning) return
    trackGeometryUpdate(layoutQueue.request({ sessionId: player.sessionId,
      video: geometry(), overlay: overlayGeometry(), context: overlayContext() }))
  })
}

const syncOverlayContext = () => {
  if (!isNative.value || !player || !nativeReady || nativeTransitioning) return
  syncGeometry()
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
  if ([PlayerStatus.ERROR, PlayerStatus.CLOSED, PlayerStatus.LOADING, PlayerStatus.OPENING].includes(snapshot.status)) osd.reset()
  else osd.accept(snapshot.osd)
  if ([PlayerStatus.ERROR, PlayerStatus.CLOSED, PlayerStatus.LOADING, PlayerStatus.ENDED].includes(snapshot.status)) seekController.reset()
  if (snapshot.error) emit('error', snapshot.error)
}


const createPlayer = async () => {
  const currentGeneration = ++generation
  const mode = props.kind === 'video' ? await selectPlayerBackend() : 'web'
  if (currentGeneration !== generation) return
  backendMode.value = mode
  emit('backend', mode)
  await nextTick()
  if (currentGeneration !== generation) return
  if (mode === 'mpv') {
    const bounds = await waitForNativeGeometry({ measure: geometry,
      cancelled: () => currentGeneration !== generation })
    if (!bounds || currentGeneration !== generation) return
    player = new NativeMpvPlayerBackend({ autoplay: props.autoplay })
    console.info(`[player=${player.sessionId}] viewer mounted`)
    console.info(`[player=${player.sessionId}] backend selected: ${mode}`)
    unsubscribeState = player.subscribe(applyState)
    await player.setSource(sourceLocation(), bounds)
    if (currentGeneration !== generation) return
    nativeReady = true
    attachNativeGeometry()
    await player.setOverlay(true, overlayGeometry(), overlayContext())
  } else {
    player = new WebMediaPlayerBackend(mediaElement.value, { autoplay: props.autoplay, historyEnabled: props.historyEnabled })
    unsubscribeState = player.subscribe(applyState)
    await player.setSource(props.src, sourceLocation())
  }
}

watch(() => props.autoplay, (value) => { if (player) player.autoplay = value })

const pause = () => { seekController.reset(); thumbnail.hide(); return player?.pause() }
const play = () => player?.play()
const seek = (seconds) => { seekController.reset(); return player?.seek(seconds) }
const stop = () => { seekController.reset(); thumbnail.hide(); return player?.stop() }
const coverNativeTransition = async () => {
  const current = ++nativeTransitionGeneration
  seekController.reset()
  thumbnail.hide()
  nativeTransitioning = true
  cancelAnimationFrame(geometryFrame)
  layoutQueue.cancel()
  await Promise.allSettled([...pendingGeometryUpdates])
  if (current !== nativeTransitionGeneration) return
  // WebViews resize and repaint asynchronously, so a WebView cover shows stale
  // geometry for a frame. The native cover resizes with the window itself.
  nativeCover = await setNativeTransitionCover(true, 150).catch((error) => {
    console.warn('Native transition cover failed', error)
    return false
  })
  if (current !== nativeTransitionGeneration) return
  if (nativeCover) {
    if (nativeReady && player) await player.setVisible(false)
    return
  }
  await mediaOverlay.fade(true)
  if (current !== nativeTransitionGeneration) return
  if (!nativeReady || !player) return
  // A WebView paint acknowledgement cannot fence native sibling composition.
  // Remove video from composition before either sibling changes its bounds.
  await player.setVisible(false)
  if (current !== nativeTransitionGeneration) return
  // The window-thread acknowledgement precedes the compositor's next frame.
  // Keep the opaque cover still while the hidden video leaves composition.
  await new Promise((resolve) => setTimeout(resolve, 150))
  if (current !== nativeTransitionGeneration) return
  const viewport = viewportGeometry()
  await player.setOverlay(true, viewport, overlayContext())
  if (current !== nativeTransitionGeneration) return
  await mediaOverlay.fade(true, { immediate: true, viewport })
}
const uncoverNative = async () => {
  nativeCover = false
  await setNativeTransitionCover(false, 180).catch((error) => console.warn('Native transition cover failed', error))
}
const revealUnderNativeCover = async (current) => {
  try {
    if (nativeReady && player) {
      // Final layout happens under the cover. The overlay WebView repaints
      // after its resize, so wait until it presents the new size.
      const bounds = overlayGeometry()
      await player.setOverlay(true, bounds, overlayContext())
      await mediaOverlay.fade(false, { immediate: true, viewport: bounds }).catch(() => {})
      if (current !== nativeTransitionGeneration) return
      await player.setGeometry(geometry())
      await player.setVisible(true)
      // WKWebView can suspend rAF while the native cover occludes it. Native
      // geometry/visibility acknowledgements have already reached AppKit;
      // allow compositor time without waiting on the covered main WebView.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } finally {
    if (current === nativeTransitionGeneration) {
      await uncoverNative()
      if (current === nativeTransitionGeneration) syncGeometry()
    }
  }
}
const revealNativeTransition = async () => {
  // Invalidate delayed cover/settle continuations after a timeout.
  const current = ++nativeTransitionGeneration
  nativeTransitioning = false
  if (nativeCover) return revealUnderNativeCover(current)
  try {
    if (nativeReady && player) {
      const bounds = overlayGeometry()
      await player.setOverlay(true, bounds, overlayContext())
      if (current !== nativeTransitionGeneration) return
      await mediaOverlay.fade(true, { immediate: true, viewport: bounds })
      if (current !== nativeTransitionGeneration) return
      // Native fullscreen animation can finish during the fixed hold. Apply
      // its final bounds once, while the surface is still hidden and covered.
      await player.setGeometry(geometry())
      if (current !== nativeTransitionGeneration) return
      await player.setVisible(true)
    }
  } finally {
    if (current === nativeTransitionGeneration) {
      await mediaOverlay.fade(false)
      if (current === nativeTransitionGeneration) syncGeometry()
    }
  }
}
const settleNativePresentation = async () => {
  // Under the native cover the layout is applied once, when revealing.
  if (nativeCover || !nativeReady || !player) return
  const current = nativeTransitionGeneration
  await nextTick()
  cancelAnimationFrame(geometryFrame)
  await player.setOverlay(true, overlayGeometry(), overlayContext())
  if (current !== nativeTransitionGeneration) return
  await mediaOverlay.fade(true, { immediate: true, viewport: overlayGeometry() })
  if (current !== nativeTransitionGeneration) return
  await player.setGeometry(geometry())
  if (current !== nativeTransitionGeneration) return
  // Keep video hidden throughout the fixed 500 ms hold. Reveal applies final
  // bounds and restores visibility under the opaque cover before fading in.
}
onMounted(() => {
  document.addEventListener('keydown', handleVideoKeydown, true)
  void createPlayer().catch((error) => emit('error', error))
})

watch(
  () => [props.src, props.providerId, props.path],
  () => {
    seekController.reset()
    thumbnail.hide()
    chaptersOpen.value = false
    if (!player) return
    nativeReady = false
    const activePlayer = player
    const currentGeneration = ++generation
    const request = isNative.value
      ? activePlayer.setSource(sourceLocation(), geometry()).then(async () => {
          if (currentGeneration !== generation || activePlayer !== player) return
          nativeReady = true
          attachNativeGeometry()
          await player.setOverlay(true, overlayGeometry(), overlayContext())
        })
      : player.setSource(props.src, sourceLocation())
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
  osd.dispose()
  seekController.reset()
  document.removeEventListener('keydown', handleVideoKeydown, true)
  generation += 1
  nativeTransitionGeneration += 1
  if (nativeCover) void uncoverNative()
  cancelAnimationFrame(geometryFrame)
  layoutQueue.cancel()
  resizeObserver?.disconnect()
  window.removeEventListener('resize', syncGeometry)
  document.removeEventListener('shown.bs.modal', handleLayoutSettled)
  document.removeEventListener('transitionend', handleLayoutSettled)
  unsubscribeState?.()
  player?.close()
  nativeReady = false
  player = null
})

defineExpose({ mediaElement, pause, play, seek, stop, coverNativeTransition, revealNativeTransition, settleNativePresentation })
</script>

<template>
  <div v-if="isNative" class="custom-media-player native-mpv-player is-video">
    <div ref="nativeSurface" class="native-mpv-surface" aria-label="Native video surface">
      <span v-if="[PlayerStatus.OPENING, PlayerStatus.LOADING].includes(state.status)" class="spinner-border text-light" aria-label="Loading video" />
    </div>
  </div>

  <media-controller
    v-else
    class="custom-media-player"
    :class="isAudio ? 'is-audio' : 'is-video'"
    :audio="isAudio || undefined"
    @mediaplayrequest="player?.expectAction?.('play')"
    @mediapauserequest="player?.expectAction?.('pause')"
    :hotkeys="!isAudio ? 'noarrowleft noarrowright' : undefined"
  >
    <audio v-if="isAudio" ref="mediaElement" slot="media" :autoplay="autoplay" preload="metadata" @error="emit('error')" />
    <video v-else ref="mediaElement" slot="media" :autoplay="autoplay" playsinline preload="metadata" @error="emit('error')" />
    <MediaOsd v-if="!isAudio" slot="top-chrome" :message="osdMessage" />
    <span v-if="seekFeedback" slot="centered-chrome" class="video-seek-feedback" role="status">{{ seekFeedback.delta > 0 ? '+' : '' }}{{ Math.round(seekFeedback.delta) }} s</span>
    <media-loading-indicator v-if="!isAudio" slot="centered-chrome" noautohide />
    <media-play-button v-if="!isAudio" slot="centered-chrome" class="custom-media-player-centered-play" aria-label="Play or pause video" />
    <media-control-bar class="custom-media-player-controls" :noautohide="chaptersOpen || undefined">
      <media-play-button aria-label="Play or pause" />
      <media-time-display showduration />
      <div class="video-preview-track">
        <ThumbnailPreview v-if="!isAudio" :preview="thumbnail.preview" />
        <media-time-range aria-label="Playback position" :style="!isAudio ? { '--media-preview-box-display': 'none' } : undefined" @mediapreviewrequest="handlePreview" @pointerdown="seekController.reset()" @mediaseekrequest="seekController.reset()" />
      </div>
      <media-mute-button aria-label="Mute or unmute" />
      <media-volume-range aria-label="Volume" />
      <ChapterControls :chapters="state.chapters" :current-chapter-index="state.currentChapterIndex" :open="chaptersOpen"
        :disabled="![PlayerStatus.READY, PlayerStatus.PLAYING, PlayerStatus.PAUSED].includes(state.status)"
        @toggle="chaptersOpen = !chaptersOpen" @close="chaptersOpen = false" @select="selectChapter" @previous="chapterStep(-1)" @next="chapterStep(1)" />
      <media-playback-rate-button v-if="!isAudio" />
      <media-pip-button v-if="!isAudio" />
      <button v-if="!isAudio" class="media-control-button" type="button" title="Enter fullscreen" aria-label="Enter fullscreen" @click="emit('fullscreen')"><i class="mdi mdi-fullscreen" aria-hidden="true" /></button>
    </media-control-bar>
  </media-controller>
</template>
