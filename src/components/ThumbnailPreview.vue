<script setup>
import { formatMediaDuration } from '../utils/mediaInfo.js'
defineProps({ preview: { type: Object, required: true } })
</script>

<template>
  <div v-if="preview.visible" class="video-thumbnail-preview" :style="{ left: `clamp(94px, ${preview.ratio * 100}%, calc(100% - 94px))` }" aria-hidden="true">
    <img v-if="preview.url" :src="preview.url" alt="">
    <span v-else-if="preview.loading" class="video-thumbnail-placeholder"><i class="mdi mdi-image-outline" /></span>
    <span class="video-thumbnail-time">{{ formatMediaDuration(preview.time) }}</span>
  </div>
</template>

<style>
.video-thumbnail-preview {
  position: absolute; bottom: calc(100% + 8px); z-index: 5; pointer-events: none;
  transform: translateX(-50%); padding: 4px; border-radius: 6px;
  background: var(--bs-dark, #212529); color: #fff; box-shadow: 0 2px 8px #0008;
}
.video-thumbnail-preview img { display: block; width: 180px; max-height: 140px; object-fit: contain; border-radius: 3px; }
.video-thumbnail-placeholder { display: grid; place-items: center; width: 180px; height: 100px; opacity: .6; }
.video-thumbnail-time { display: block; text-align: center; font-size: 12px; line-height: 1.4; font-variant-numeric: tabular-nums; white-space: nowrap; }
.video-seek-feedback { position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%); padding: 8px 14px; border-radius: 8px; background: #000a; color: #fff; pointer-events: none; z-index: 5; }
.video-preview-track { position: relative; min-width: 0; flex: 1; }
.video-preview-track media-time-range { width: 100%; }
</style>
