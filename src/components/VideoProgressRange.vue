<script setup>
import { ref, watch } from 'vue'
import ThumbnailPreview from './ThumbnailPreview.vue'
import { useThumbnailPreview } from '../composables/useThumbnailPreview.js'
import { createProgressDrag } from '../player/progressRange.js'
import { clampTime } from '../player/seekController.js'
const props = defineProps({
  currentTime: { type: Number, default: 0 }, duration: { type: Number, default: 0 },
  path: { type: String, default: '' }, providerId: { type: String, default: 'local' },
  sourceHdr: { type: Boolean, default: false },
})
const emit = defineEmits(['seek', 'drag'])
const dragTime = ref(null)
const thumbnail = useThumbnailPreview(() => ({ path: props.path, providerId: props.providerId, sourceHdr: props.sourceHdr }))
const drag = createProgressDrag({
  getDuration: () => props.duration,
  preview: thumbnail.show,
  onDrag: () => emit('drag'),
  onCommit: (time) => emit('seek', time),
  onChange: (time) => { dragTime.value = time },
})
const input = (event) => {
  dragTime.value = clampTime(event.target.value, props.duration)
  thumbnail.show(dragTime.value, props.duration ? dragTime.value / props.duration : 0)
}
const commit = (event) => {
  if (drag.active()) return
  emit('seek', clampTime(event.target.value, props.duration))
  dragTime.value = null
}
const cancel = () => { drag.cancel(); thumbnail.hide() }
watch(() => [props.path, props.providerId, props.sourceHdr], cancel)
defineExpose({ hidePreview: cancel })
</script>

<template>
  <div class="video-preview-track" @pointerleave="thumbnail.hide" @pointercancel="cancel">
    <ThumbnailPreview :preview="thumbnail.preview" :controls-target="true" />
    <input class="form-range media-overlay-seek" type="range" min="0" :max="duration || 0" step="0.1" :value="dragTime ?? currentTime" :disabled="!duration" aria-label="Playback position"
      @pointerdown="drag.start" @pointermove="drag.update" @pointerup="drag.end"
      @pointercancel="cancel" @lostpointercapture="cancel" @input="input" @change="commit" @blur="cancel">
  </div>
</template>
