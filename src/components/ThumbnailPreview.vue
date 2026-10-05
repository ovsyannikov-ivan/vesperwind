<script setup>
import { traceMedia } from '../api/mediaDiagnostics.js'
import { formatMediaDuration } from '../utils/mediaInfo.js'
defineProps({ preview: { type: Object, required: true }, controlsTarget: { type: Boolean, default: false } })
</script>

<template>
  <div v-if="preview.visible" class="video-thumbnail-preview" :class="{ 'is-controls-target': controlsTarget }" :style="{ left: `clamp(${preview.url ? 94 : 30}px, ${preview.ratio * 100}%, calc(100% - ${preview.url ? 94 : 30}px))` }" aria-hidden="true">
    <Transition name="thumbnail-image" @leave="(_element, done) => done()">
      <img v-if="preview.url" :key="preview.url" :src="preview.url" alt="" @load="traceMedia('thumbnail.presented', { width: $event.target.naturalWidth })">
    </Transition>
    <span class="video-thumbnail-time">{{ formatMediaDuration(preview.time) }}</span>
  </div>
</template>

<style>
.video-thumbnail-preview {
  position: absolute; bottom: calc(100% + 8px); z-index: 5; pointer-events: none;
  transform: translateX(-50%); padding: 4px; border-radius: 6px;
  background: var(--bs-dark, #212529); color: #fff; box-shadow: 0 2px 8px #0008;
}
.video-thumbnail-preview.is-controls-target { pointer-events: auto; }
.video-thumbnail-preview img { display: block; width: 180px; max-height: 140px; object-fit: contain; border-radius: 3px; }
.thumbnail-image-enter-active { transition: opacity 180ms ease-out; }
.thumbnail-image-enter-from { opacity: 0; }
/* No leave animation: a moved pointer must hide the old frame immediately. */
@media (prefers-reduced-motion: reduce) { .thumbnail-image-enter-active { transition: none; } }
.video-thumbnail-time { display: block; text-align: center; font-size: 12px; line-height: 1.4; font-variant-numeric: tabular-nums; white-space: nowrap; }
.video-seek-feedback { position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%); padding: 8px 14px; border-radius: 8px; background: #000a; color: #fff; pointer-events: none; z-index: 5; }
.video-preview-track { position: relative; min-width: 0; flex: 1; }
.video-preview-track media-time-range { width: 100%; }
</style>
