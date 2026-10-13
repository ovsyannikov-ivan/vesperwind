<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { createVideoMouseInteraction } from '../player/videoMouseInteraction.js'

const props = defineProps({
  enabled: { type: Boolean, default: false },
  sourceKey: { type: String, default: '' },
})
const emit = defineEmits(['seek', 'toggle', 'fullscreen'])
const surface = ref(null)
const mouse = createVideoMouseInteraction({
  enabled: () => props.enabled,
  getRect: () => surface.value?.getBoundingClientRect(),
  onSeek: (delta) => emit('seek', delta),
  onToggle: () => emit('toggle'),
  onFullscreen: () => emit('fullscreen'),
})
watch(() => [props.enabled, props.sourceKey], mouse.reset, { flush: 'sync' })
onBeforeUnmount(mouse.reset)
</script>

<template>
  <div
    ref="surface"
    class="video-mouse-surface"
    aria-hidden="true"
    @pointerdown="mouse.down"
    @pointermove="mouse.move"
    @pointerup="mouse.up"
    @pointerleave="mouse.cancelPress"
    @pointercancel="mouse.cancelPress"
    @click="mouse.click"
    @dblclick="mouse.doubleClick"
  />
</template>

<style lang="scss">
.video-mouse-surface {
  position: absolute;
  inset: 0;
  // The gesture slot precedes Media Chrome controls; native controls have their
  // own higher stacking levels. Do not raise this surface above either set.
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
}
</style>
