<script setup>
defineProps({
  layout: {
    type: Object,
    required: true,
  },
  activePanel: {
    type: String,
    required: true,
  },
  connected: {
    type: Boolean,
    required: true,
  },
})

defineEmits(['toggle-left', 'toggle-right', 'toggle-terminal'])
</script>

<template>
  <header class="app-toolbar">
    <div class="brand-mark" aria-label="Pelorus file manager">
      <i class="mdi mdi-compass-outline" aria-hidden="true" />
      <span>Pelorus</span>
    </div>

    <div class="toolbar-divider" />

    <div class="btn-group btn-group-sm" role="group" aria-label="Panel visibility">
      <button
        class="btn toolbar-button"
        :class="{ 'is-visible': layout.leftVisible }"
        type="button"
        :aria-pressed="layout.leftVisible"
        title="Show or hide the left panel"
        @click="$emit('toggle-left')"
      >
        <i class="mdi mdi-dock-left" aria-hidden="true" />
        Left
      </button>
      <button
        class="btn toolbar-button"
        :class="{ 'is-visible': layout.rightVisible }"
        type="button"
        :aria-pressed="layout.rightVisible"
        title="Show or hide the right panel"
        @click="$emit('toggle-right')"
      >
        <i class="mdi mdi-dock-right" aria-hidden="true" />
        Right
      </button>
    </div>

    <button
      class="btn btn-sm toolbar-button ms-1"
      :class="{ 'is-visible': layout.terminalVisible }"
      type="button"
      :aria-pressed="layout.terminalVisible"
      title="Show or hide the terminal"
      @click="$emit('toggle-terminal')"
    >
      <i class="mdi mdi-console-line" aria-hidden="true" />
      Terminal
    </button>

    <div class="toolbar-spacer" />

    <div class="active-panel-indicator">
      <span>Active</span>
      <strong>{{ activePanel }}</strong>
    </div>

    <div
      class="connection-indicator"
      :class="{ 'is-connected': connected }"
      :title="connected ? 'Backend connected' : 'Backend disconnected'"
    >
      <span class="connection-dot" />
      {{ connected ? 'Local' : 'Offline' }}
    </div>
  </header>
</template>
