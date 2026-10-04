<script setup>
import { ref } from 'vue'
import { FILE_ENTRY_MIME, parseFileDragPayload } from '../utils/fileDrag.js'
import { formatChapterTime } from '../player/chapters.js'
const props = defineProps({ audio: { type: Object, required: true } })
const dropTarget = ref(false)
const dragOver = (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes(FILE_ENTRY_MIME)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  dropTarget.value = true
}
const drop = (event) => {
  dropTarget.value = false
  const payload = parseFileDragPayload(event.dataTransfer?.getData(FILE_ENTRY_MIME))
  if (!payload) return
  event.preventDefault()
  event.stopPropagation()
  props.audio.add(payload.sources || [payload])
}
</script>

<template>
  <section class="audio-playlist" :class="{ 'is-drop-target': dropTarget }" aria-label="Playlist" @dragover="dragOver" @dragleave="!$el.contains($event.relatedTarget) && (dropTarget = false)" @drop="drop">
    <div class="audio-playlist-actions">
      <span class="text-body-secondary">Playlist · {{ audio.state.items.length }}</span>
      <button class="btn btn-sm btn-neutral" type="button" :disabled="!audio.state.selectedId" @click="audio.remove([audio.state.selectedId])">Remove selected</button>
      <button class="btn btn-sm btn-neutral" type="button" :disabled="!audio.state.items.length" @click="audio.clear()">Clear playlist</button>
    </div>
    <div class="audio-playlist-scroll">
      <table class="table table-sm mb-0 audio-playlist-table" aria-label="Audio playlist">
        <thead><tr><th scope="col" aria-label="Current track" /><th scope="col">Filename</th><th scope="col" class="text-end">Duration</th></tr></thead>
        <tbody>
          <tr v-for="item in audio.state.items" :key="item.key" :class="{ 'is-current': item.id === audio.state.currentId, 'is-selected': item.id === audio.state.selectedId }"
            tabindex="0" :aria-selected="item.id === audio.state.selectedId" :title="`${item.providerId}: ${item.path}`"
            @click="audio.state.selectedId = item.id" @dblclick="audio.play(item.id)" @keydown.enter.prevent="audio.play(item.id)" @keydown.space.prevent="audio.state.selectedId = item.id">
            <td><i v-if="item.id === audio.state.currentId" :class="['mdi', audio.state.playbackStatus === 'playing' ? 'mdi-play' : 'mdi-pause']" aria-label="Current track" /></td>
            <td class="audio-playlist-name">{{ item.name }}</td><td class="text-end audio-playlist-duration">{{ item.duration == null ? '—' : formatChapterTime(item.duration) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!audio.state.items.length" class="audio-playlist-empty text-body-secondary">Drag audio files here</div>
    </div>
  </section>
</template>
