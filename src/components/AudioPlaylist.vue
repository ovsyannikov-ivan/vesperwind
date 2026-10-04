<script setup>
import { trackTitle, mediaSourceLabel } from '../player/mediaSource.js'
import { PLAYLIST_ROW_MIME, readPlaylistRowDrop } from '../player/playlistDrag.js'
import { ref } from 'vue'
import { FILE_ENTRY_MIME, parseFileDragPayload } from '../utils/fileDrag.js'
import { formatChapterTime } from '../player/chapters.js'
const props = defineProps({ audio: { type: Object, required: true }, status: { type: String, default: '' } })
const emit = defineEmits(['open-url', 'import', 'export'])
const dropTarget = ref(false), rowTarget = ref(null)
const rowDrag = (event, item) => { event.dataTransfer.setData(PLAYLIST_ROW_MIME, item.id); event.dataTransfer.effectAllowed = 'move' }
const rowOver = (event, item) => {
  if (!Array.from(event.dataTransfer?.types || []).includes(PLAYLIST_ROW_MIME)) return
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
  rowTarget.value = { id: item.id, after: event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 }
}
const rowDrop = (event, item) => {
  const id = readPlaylistRowDrop(event.dataTransfer)
  if (!id) return
  event.preventDefault(); event.stopPropagation()
  props.audio.reorder(id, item.id, rowTarget.value?.after || false); rowTarget.value = null
}
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
      <button class="btn btn-sm btn-neutral" type="button" @click="emit('open-url')">Open URL…</button>
      <button class="btn btn-sm btn-neutral" type="button" @click="emit('import')">Import…</button>
      <button class="btn btn-sm btn-neutral" type="button" :disabled="!audio.state.items.length" @click="emit('export')">Export playlist…</button>
      <span class="text-body-secondary">Playlist · {{ audio.state.items.length }}</span>
      <button class="btn btn-sm btn-neutral" type="button" :disabled="!audio.state.selectedId" @click="audio.remove([audio.state.selectedId])">Remove selected</button>
      <button class="btn btn-sm btn-neutral" type="button" :disabled="!audio.state.items.length" @click="audio.clear()">Clear playlist</button>
    </div>
    <p v-if="status" class="playlist-status text-body-secondary" role="status">{{ status }}</p>
    <div class="audio-playlist-scroll">
      <table class="table table-sm mb-0 audio-playlist-table" aria-label="Audio playlist">
        <thead><tr><th scope="col" aria-label="Current track" /><th scope="col" aria-label="Reorder" /><th scope="col">Title</th><th scope="col" class="playlist-artist">Artist</th><th scope="col" class="playlist-album">Album</th><th scope="col" class="text-end">Duration</th></tr></thead>
        <tbody>
          <tr v-for="item in audio.state.items" :key="item.key" :class="{ 'is-current': item.id === audio.state.currentId, 'is-selected': item.id === audio.state.selectedId, 'drop-before': rowTarget?.id === item.id && !rowTarget.after, 'drop-after': rowTarget?.id === item.id && rowTarget.after }"
            tabindex="0" :aria-selected="item.id === audio.state.selectedId" :title="mediaSourceLabel(item)" @dragover="rowOver($event, item)" @drop="rowDrop($event, item)"
            @click="audio.state.selectedId = item.id" @dblclick="audio.play(item.id)" @keydown.enter.prevent="audio.play(item.id)" @keydown.space.prevent="audio.state.selectedId = item.id">
            <td><i v-if="item.id === audio.state.currentId" :class="['mdi', audio.state.playbackStatus === 'playing' ? 'mdi-play' : 'mdi-pause']" aria-label="Current track" /></td>
            <td class="playlist-drag-cell"><button class="compact-icon-button" type="button" draggable="true" title="Drag to reorder track" aria-label="Drag to reorder track" @dragstart="rowDrag($event, item)" @dragend="rowTarget = null" @dblclick.stop><i class="mdi mdi-drag-vertical" aria-hidden="true" /></button></td>
            <td class="audio-playlist-name" :title="trackTitle(item)">{{ trackTitle(item) }}</td><td class="audio-playlist-name playlist-artist" :title="item.tags?.artist">{{ item.tags?.artist || '' }}</td><td class="audio-playlist-name playlist-album" :title="item.tags?.album">{{ item.tags?.album || '' }}</td><td class="text-end audio-playlist-duration">{{ item.duration == null ? '—' : formatChapterTime(item.duration) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!audio.state.items.length" class="audio-playlist-empty text-body-secondary">Drag audio files here</div>
    </div>
  </section>
</template>
