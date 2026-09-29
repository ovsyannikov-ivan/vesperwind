<script setup>
import { formatFileSize, formatModifiedAt } from '../utils/fileMetadata.js'
import { useSettings } from '../composables/useSettings.js'
import { getFileIcon } from '../utils/fileIcons.js'
defineProps({ results: { type: Array, required: true }, compact: { type: Boolean, default: false } })
const emit = defineEmits(['open', 'reveal', 'context-menu'])
const { settings } = useSettings()
const showContext = (event, node) => {
  event.preventDefault()
  emit('context-menu', { node, x: event.clientX, y: event.clientY })
}
</script>
<template>
  <div class="search-results" role="list" aria-label="Search results">
    <div v-for="entry in results" :key="entry.path" class="search-result" role="listitem"
      tabindex="0" :title="entry.path" @click="compact && emit('open', entry)" @dblclick="!compact && emit('open', entry)"
      @keydown.enter.prevent="emit('open', entry)" @contextmenu="showContext($event, entry)">
      <i class="mdi" :class="getFileIcon(entry).icon" aria-hidden="true" />
      <span class="search-result-text"><span class="search-result-name">{{ entry.name }}</span><small>{{ entry.relativePath }}</small></span>
      <span v-if="!compact" class="search-result-size">{{ formatFileSize(entry.size, entry.isDirectory) }}</span>
      <span v-if="!compact" class="search-result-date">{{ formatModifiedAt(entry.modifiedAt, settings.appearance.locale) }}</span>
      <button class="search-result-reveal" type="button" :aria-label="`Go to containing folder of ${entry.name}`" title="Go to containing folder" @click.stop="emit('reveal', entry)" @keydown.enter.stop @keydown.space.stop><i class="mdi mdi-folder-search-outline" aria-hidden="true" /></button>
    </div>
  </div>
</template>
