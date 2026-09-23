<script setup>
import Modal from 'bootstrap/js/dist/modal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CustomMediaPlayer from './CustomMediaPlayer.vue'
import { fullscreen } from '../api/fullscreen.js'
import { mediaOverlay } from '../api/mediaOverlay.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  media: {
    type: Object,
    default: null,
  },
  kind: {
    type: String,
    default: '',
  },
  position: {
    type: Number,
    default: 0,
  },
  total: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits(['close', 'previous', 'next', 'retry'])
const modalElement = ref(null)
const stageElement = ref(null)
const videoPlayer = ref(null)
const displayedMedia = ref(null)
const displayedKind = ref('')
const playbackError = ref('')
const isFullscreen = ref(false)
const playerBackend = ref('')
const isNativeVideo = computed(() => displayedKind.value === 'video' && playerBackend.value === 'mpv')
let modal = null
let unsubscribeFullscreen = null
let unsubscribeOverlayAction = null

const handlePlaybackError = (error) => {
  playbackError.value = error?.message || 'This video could not be played'
}

const requestClose = async () => {
  if (isFullscreen.value) await fullscreen.exit()
  emit('close')
}

const enterFullscreen = async () => {
  await fullscreen.enter(stageElement.value)
}
const exitFullscreen = () => fullscreen.exit()
const toggleFullscreen = () => isFullscreen.value ? exitFullscreen() : enterFullscreen()
const handleOverlayAction = (payload) => {
  if (payload?.action === 'close') void requestClose()
  else if (payload?.action === 'fullscreen') void toggleFullscreen()
  else if (payload?.action === 'previous') emit('previous')
  else if (payload?.action === 'next') emit('next')
}

const handleKeydown = (event) => {
  if (event.key === 'Escape' && isFullscreen.value) {
    event.preventDefault()
    exitFullscreen()
    return
  }
  if (!props.open || props.total < 2) {
    return
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    emit('previous')
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    emit('next')
  }
}

const handleHidden = () => {
  videoPlayer.value?.pause()
  if (isFullscreen.value) void fullscreen.exit()

  if (props.open) {
    emit('close')
  }
}

watch(
  () => [props.media, props.kind],
  ([media, kind]) => {
    if (media) {
      videoPlayer.value?.pause()
      displayedMedia.value = media
      displayedKind.value = kind
      playbackError.value = ''
      playerBackend.value = ''
    }
  },
  { immediate: true },
)

watch(
  () => props.open,
  (isOpen) => {
    if (!modal) {
      return
    }

    if (isOpen) {
      modal.show()
    } else {
      modal.hide()
    }
  },
)

onMounted(() => {
  modal = new Modal(modalElement.value)
  modalElement.value.addEventListener('hidden.bs.modal', handleHidden)
  window.addEventListener('keydown', handleKeydown)
  unsubscribeFullscreen = fullscreen.onChange((value) => {
    isFullscreen.value = value
  })
  unsubscribeOverlayAction = mediaOverlay.onAction(handleOverlayAction)

  if (props.open) {
    modal.show()
  }
})

onBeforeUnmount(() => {
  modalElement.value?.removeEventListener('hidden.bs.modal', handleHidden)
  window.removeEventListener('keydown', handleKeydown)
  unsubscribeFullscreen?.()
  unsubscribeOverlayAction?.()
  modal?.dispose()
  modal = null
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="modalElement"
      class="modal fade"
      tabindex="-1"
      aria-labelledby="media-viewer-title"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-xl modal-dialog-centered media-viewer-dialog">
        <div class="modal-content" :class="{ 'is-native-video': isNativeVideo }">
          <div v-if="!isNativeVideo" class="modal-header">
            <h1
              id="media-viewer-title"
              class="modal-title fs-6 d-flex align-items-center gap-2 text-truncate"
            >
              <i
                class="mdi"
                :class="displayedKind === 'video' ? 'mdi-movie-open-play-outline' : 'mdi-image-outline'"
                aria-hidden="true"
              />
              <span class="text-truncate" :title="displayedMedia?.path">
                {{ displayedMedia?.name }}
              </span>
              <span v-if="total > 1" class="media-viewer-position text-body-secondary">
                {{ position }} / {{ total }}
              </span>
            </h1>
            <div class="d-flex align-items-center gap-2 ms-auto">
              <button
                v-if="['image', 'video'].includes(displayedKind)"
                class="media-viewer-header-action"
                type="button"
                title="Enter fullscreen"
                aria-label="Enter fullscreen"
                @click="enterFullscreen"
              >
                <i class="mdi mdi-fullscreen" aria-hidden="true" />
              </button>
              <button
                class="btn-close"
                type="button"
                aria-label="Close"
                @click="requestClose"
              />
            </div>
          </div>

          <div ref="stageElement" class="modal-body media-viewer-stage">
            <div v-if="displayedMedia?.loading" class="pdf-viewer-message">
              <span class="spinner-border spinner-border-sm" aria-hidden="true" />
              {{ displayedMedia.statusMessage || 'Preparing file…' }}
            </div>
            <div v-else-if="displayedMedia?.error" class="pdf-viewer-message text-danger" role="alert">
              <i class="mdi mdi-alert-outline" aria-hidden="true" />
              <span>{{ displayedMedia.error.message }}</span>
              <button class="btn btn-sm btn-outline-secondary" type="button" @click="$emit('retry')">
                Retry
              </button>
            </div>
            <img
              v-else-if="displayedMedia?.url && displayedKind === 'image'"
              :key="displayedMedia.path"
              class="media-viewer-image"
              :src="displayedMedia.url"
              :alt="displayedMedia.name"
              draggable="false"
              @error="playbackError = 'This image could not be displayed by the browser'"
            >
            <CustomMediaPlayer
              v-else-if="displayedMedia?.url && displayedKind === 'video'"
              ref="videoPlayer"
              :key="displayedMedia.path"
              class="media-viewer-video"
              kind="video"
              :src="displayedMedia.url"
              :provider-id="displayedMedia.providerId"
              :path="displayedMedia.path"
              autoplay
              :title="displayedMedia.name"
              :position="position"
              :total="total"
              :fullscreen="isFullscreen"
              @backend="playerBackend = $event"
              @fullscreen="toggleFullscreen"
              @error="handlePlaybackError"
            />
            <button v-if="isFullscreen && !isNativeVideo" class="btn media-viewer-fullscreen-exit" type="button" title="Exit fullscreen" aria-label="Exit fullscreen" @click="exitFullscreen"><i class="mdi mdi-close" aria-hidden="true" /></button>

            <template v-if="total > 1 && !isNativeVideo">
              <button
                class="btn media-viewer-navigation is-previous"
                type="button"
                aria-label="Previous item"
                title="Previous item (Left arrow)"
                @click="$emit('previous')"
              >
                <i class="mdi mdi-chevron-left" aria-hidden="true" />
              </button>
              <button
                class="btn media-viewer-navigation is-next"
                type="button"
                aria-label="Next item"
                title="Next item (Right arrow)"
                @click="$emit('next')"
              >
                <i class="mdi mdi-chevron-right" aria-hidden="true" />
              </button>
              <span class="media-viewer-stage-position" aria-hidden="true">
                {{ position }} / {{ total }}
              </span>
            </template>

            <div
              v-if="playbackError"
              class="alert alert-danger media-viewer-error"
              role="alert"
            >
              {{ playbackError }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
