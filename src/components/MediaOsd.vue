<script setup>
defineProps({ message: { type: Object, default: null } })
</script>

<template>
  <Transition name="media-osd">
    <div v-if="message" class="media-osd" role="status" aria-live="polite" aria-atomic="true">
      <div class="media-osd-title">{{ message.title }}</div>
      <div class="media-osd-detail">{{ message.detail }}</div>
    </div>
  </Transition>
</template>

<style scoped>
.media-osd {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 4;
  max-width: calc(100% - 80px);
  padding: 8px 12px;
  border-radius: 8px;
  background: rgb(20 20 22 / 76%);
  color: white;
  font-size: 13px;
  line-height: 1.4;
  pointer-events: none;
  box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
}
.media-osd-title { font-weight: 600; }
.media-osd-detail { opacity: .9; overflow-wrap: anywhere; }
.media-osd-enter-active, .media-osd-leave-active { transition: opacity 120ms ease; }
.media-osd-enter-from, .media-osd-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .media-osd-enter-active, .media-osd-leave-active { transition: none; }
}
</style>
