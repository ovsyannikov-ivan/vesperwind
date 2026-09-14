<script setup>
import 'media-chrome/dist/media-controller.js'
import 'media-chrome/dist/media-control-bar.js'
import 'media-chrome/dist/media-fullscreen-button.js'
import 'media-chrome/dist/media-loading-indicator.js'
import 'media-chrome/dist/media-mute-button.js'
import 'media-chrome/dist/media-pip-button.js'
import 'media-chrome/dist/media-play-button.js'
import 'media-chrome/dist/media-playback-rate-button.js'
import 'media-chrome/dist/media-time-display.js'
import 'media-chrome/dist/media-time-range.js'
import 'media-chrome/dist/media-volume-range.js'
import { computed, ref } from 'vue'

const props = defineProps({
  src: {
    type: String,
    required: true,
  },
  kind: {
    type: String,
    required: true,
    validator: (value) => ['audio', 'video'].includes(value),
  },
  autoplay: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['error'])
const mediaElement = ref(null)
const isAudio = computed(() => props.kind === 'audio')

const pause = () => mediaElement.value?.pause()
const play = () => mediaElement.value?.play()

defineExpose({
  mediaElement,
  pause,
  play,
})
</script>

<template>
  <media-controller
    class="custom-media-player"
    :class="isAudio ? 'is-audio' : 'is-video'"
    :audio="isAudio || undefined"
  >
    <audio
      v-if="isAudio"
      ref="mediaElement"
      slot="media"
      :src="src"
      :autoplay="autoplay"
      preload="metadata"
      @error="emit('error')"
    />
    <video
      v-else
      ref="mediaElement"
      slot="media"
      :src="src"
      :autoplay="autoplay"
      playsinline
      preload="metadata"
      @error="emit('error')"
    />

    <media-loading-indicator
      v-if="!isAudio"
      slot="centered-chrome"
      noautohide
    />
    <media-play-button
      v-if="!isAudio"
      slot="centered-chrome"
      class="custom-media-player-centered-play"
      aria-label="Play or pause video"
    />

    <media-control-bar class="custom-media-player-controls">
      <media-play-button aria-label="Play or pause" />
      <media-time-display showduration />
      <media-time-range aria-label="Playback position" />
      <media-mute-button aria-label="Mute or unmute" />
      <media-volume-range aria-label="Volume" />
      <media-playback-rate-button v-if="!isAudio" />
      <media-pip-button v-if="!isAudio" />
      <media-fullscreen-button v-if="!isAudio" />
    </media-control-bar>
  </media-controller>
</template>
