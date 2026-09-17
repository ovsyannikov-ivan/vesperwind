<script setup>
import { ref, watch } from 'vue'
import CustomMediaPlayer from './CustomMediaPlayer.vue'

const props = defineProps({
  media: {
    type: Object,
    required: true,
  },
})

defineEmits(['close', 'retry'])
const playbackError = ref('')

watch(
  () => props.media.path,
  () => {
    playbackError.value = ''
  },
)
</script>

<template>
  <section class="audio-player-bar" aria-label="Audio player">
    <i class="mdi mdi-music-circle-outline audio-player-icon" aria-hidden="true" />
    <div class="audio-player-details">
      <strong :title="media.path">{{ media.name }}</strong>
      <span v-if="media.error" class="text-danger">{{ media.error.message }}</span>
      <span v-else-if="playbackError" class="text-danger">{{ playbackError }}</span>
      <span v-else-if="media.loading" class="text-body-secondary">{{ media.statusMessage || 'Preparing file…' }}</span>
      <span v-else class="text-body-secondary">Audio</span>
    </div>
    <CustomMediaPlayer
      v-if="media.url"
      :key="media.path"
      class="audio-player-control"
      kind="audio"
      :src="media.url"
      autoplay
      @error="playbackError = 'This audio codec could not be played'"
    />
    <span v-else-if="media.loading" class="spinner-border spinner-border-sm" aria-hidden="true" />
    <button
      v-else-if="media.error"
      class="btn btn-sm btn-outline-secondary"
      type="button"
      @click="$emit('retry')"
    >
      Retry
    </button>
    <button
      class="btn btn-sm toolbar-button audio-player-close"
      type="button"
      aria-label="Close audio player"
      title="Close audio player"
      @click="$emit('close')"
    >
      <i class="mdi mdi-close" aria-hidden="true" />
    </button>
  </section>
</template>
