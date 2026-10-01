<script setup>
import { ref, watch } from 'vue'
import ThumbnailPreview from './ThumbnailPreview.vue'
import { useThumbnailPreview } from '../composables/useThumbnailPreview.js'
import { clampTime } from '../player/seekController.js'
const props = defineProps({
  currentTime: { type: Number, default: 0 }, duration: { type: Number, default: 0 },
  path: { type: String, default: '' }, providerId: { type: String, default: 'local' },
  sourceHdr: { type: Boolean, default: false },
})
const emit = defineEmits(['seek', 'drag'])
const dragTime = ref(null)
const thumbnail = useThumbnailPreview(() => ({ path: props.path, providerId: props.providerId, sourceHdr: props.sourceHdr }))
const showPreview = (event) => {
  const rect = event.currentTarget.getBoundingClientRect()
  // Match the native range thumb's effective track, rather than its outer box.
  const inset = 8
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2)))
  thumbnail.show(ratio * props.duration, ratio)
}
const start = (event) => {
  event.currentTarget.setPointerCapture(event.pointerId)
  dragTime.value = props.currentTime
  emit('drag')
  showPreview(event)
}
const input = (event) => {
  dragTime.value = clampTime(event.target.value, props.duration)
  thumbnail.show(dragTime.value, props.duration ? dragTime.value / props.duration : 0)
}
const commit = (event) => {
  emit('seek', clampTime(event.target.value, props.duration))
  dragTime.value = null
}
const cancel = () => { dragTime.value = null; thumbnail.hide() }
watch(() => [props.path, props.providerId, props.sourceHdr], cancel)
defineExpose({ hidePreview: cancel })
</script>

<template>
  <div class="video-preview-track">
    <ThumbnailPreview :preview="thumbnail.preview" />
    <input class="form-range media-overlay-seek" type="range" min="0" :max="duration || 0" step="0.1" :value="dragTime ?? currentTime" :disabled="!duration" aria-label="Playback position"
      @pointerdown="start" @pointermove="showPreview" @pointerleave="dragTime === null && thumbnail.hide()"
      @pointercancel="cancel" @lostpointercapture="cancel" @input="input" @change="commit" @blur="cancel">
  </div>
</template>
