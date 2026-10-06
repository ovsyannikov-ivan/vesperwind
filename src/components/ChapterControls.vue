<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { adjacentChapterIndex, formatChapterTime } from '../player/chapters.js'

const props = defineProps({
  chapters: { type: Array, required: true },
  currentChapterIndex: { type: Number, default: null },
  open: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  controlClass: { type: String, default: 'media-control-button' },
  toggleClass: { type: String, default: 'btn btn-sm btn-neutral' },
})
const emit = defineEmits(['toggle', 'close', 'select', 'previous', 'next'])
const root = ref(null)
const menu = ref(null)
const toggle = ref(null)
const portalTarget = ref('body')
const menuStyle = ref({})
const previous = computed(() => adjacentChapterIndex(props.chapters, props.currentChapterIndex, -1))
const next = computed(() => adjacentChapterIndex(props.chapters, props.currentChapterIndex, 1))
const placeMenu = () => {
  if (!props.open || !root.value) return
  const bounds = root.value.getBoundingClientRect()
  const margin = 8
  const above = bounds.top - margin * 2
  const below = window.innerHeight - bounds.bottom - margin * 2
  const upward = above >= below
  const width = Math.min(480, window.innerWidth - margin * 2)
  menuStyle.value = {
    position: 'fixed', width: `${width}px`,
    left: `${Math.max(margin, Math.min(bounds.right - width, window.innerWidth - width - margin))}px`,
    maxHeight: `${Math.max(0, upward ? above : below)}px`,
    ...(upward ? { bottom: `${window.innerHeight - bounds.top + margin}px` }
      : { top: `${bounds.bottom + margin}px` }),
  }
}
const handleKeydown = (event) => {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    if (!props.open) { emit('toggle'); return }
    const items = [...(menu.value?.querySelectorAll('.dropdown-item') || [])]
    let index = items.indexOf(document.activeElement)
    if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = items.length - 1
    else index = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[index]?.focus()
    items[index]?.scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Escape' && props.open) {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    toggle.value?.focus()
  }
}
const handleOutside = (event) => {
  if (props.open && !root.value?.contains(event.target) && !menu.value?.contains(event.target)) emit('close')
}
watch(() => props.open, async (open) => {
  document.removeEventListener('pointerdown', handleOutside)
  window.removeEventListener('resize', placeMenu)
  if (open) {
    // Keep focus inside Bootstrap's modal focus trap for web video.
    portalTarget.value = root.value?.closest('.modal') || 'body'
    await nextTick()
    if (!props.open || !root.value) return
    placeMenu()
    document.addEventListener('pointerdown', handleOutside)
    window.addEventListener('resize', placeMenu)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutside)
  window.removeEventListener('resize', placeMenu)
})
</script>

<template>
  <div v-if="chapters.length" ref="root" class="media-chapter-controls media-overlay-dropdown" @keydown="handleKeydown">
    <button :class="controlClass" type="button" title="Previous chapter" aria-label="Previous chapter" :disabled="disabled || previous == null" @click="emit('previous')"><i class="mdi mdi-skip-previous-outline" aria-hidden="true" /></button>
    <button :class="controlClass" type="button" title="Next chapter" aria-label="Next chapter" :disabled="disabled || next == null" @click="emit('next')"><i class="mdi mdi-skip-next-outline" aria-hidden="true" /></button>
    <button ref="toggle" :class="[toggleClass, 'dropdown-toggle']" type="button" aria-haspopup="menu" :aria-expanded="open" :disabled="disabled" @click="emit('toggle')">Chapters</button>
    <Teleport :to="portalTarget">
      <ul v-if="open" ref="menu" class="dropdown-menu show media-chapter-menu media-overlay-dropdown" :style="menuStyle" role="menu" aria-label="Chapters" @keydown="handleKeydown">
        <li v-for="chapter in chapters" :key="chapter.index">
          <button class="dropdown-item" type="button" role="menuitemradio" :aria-checked="chapter.index === currentChapterIndex" @click="emit('select', chapter.index)">
            <i class="mdi" :class="chapter.index === currentChapterIndex ? 'mdi-check' : 'mdi-blank'" aria-hidden="true" />
            <span class="chapter-time">{{ formatChapterTime(chapter.startTime) }}</span>
            <span class="chapter-title" :title="chapter.title">{{ chapter.title }}</span>
          </button>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.media-chapter-controls {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
}

.media-chapter-menu {
  overflow-y: auto;
  z-index: 1100;
  margin: 0;
}

.chapter-time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.chapter-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
