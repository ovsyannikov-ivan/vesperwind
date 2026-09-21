<script setup>
import Dropdown from 'bootstrap/js/dist/dropdown'
import { onBeforeUnmount, ref, watch } from 'vue'
import { runtime } from '../api/runtime.js'
const createButton = ref(null)
let createDropdown
watch(createButton, (button) => {
  createDropdown?.dispose()
  createDropdown = button ? new Dropdown(button) : null
}, { flush: 'post' })
onBeforeUnmount(() => createDropdown?.dispose())
const visibilityButtonClass = (visible) => ({
  'is-active': visible,
})

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
  commandAvailability: {
    type: Object,
    default: () => ({ copy: false, move: false, delete: false }),
  },
  workspaceMode: {
    type: String,
    default: 'files',
  },
  editorAvailable: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'toggle-left',
  'toggle-right',
  'toggle-terminal',
  'open-settings',
  'copy',
  'move',
  'delete',
  'create',
  'show-files',
  'show-editor',
  'open-remote',
])
const selectCreate = (kind) => {
  createDropdown?.hide()
  emit('create', kind)
}
</script>

<template>
  <header class="app-toolbar">
    <template v-if="runtime.mode === 'browser'">
      <div class="brand-mark" aria-label="Vesperwind file manager">
        <img
          class="brand-icon"
          src="/icons/app_icon.png"
          width="24"
          height="24"
          alt=""
          aria-hidden="true"
        />
        <span>Vesperwind</span>
      </div>

      <div class="toolbar-divider" />
    </template>

    <div class="btn-group btn-group-sm" role="group" aria-label="Workspace mode">
      <button
        class="btn toolbar-button toolbar-toggle"
        :class="visibilityButtonClass(workspaceMode === 'files')"
        type="button"
        :aria-pressed="workspaceMode === 'files'"
        title="Show the two-panel file manager"
        @click="$emit('show-files')"
      >
        <i class="mdi mdi-folder-multiple-outline" aria-hidden="true" />
        Files
      </button>
      <button
        class="btn toolbar-button toolbar-toggle"
        :class="visibilityButtonClass(workspaceMode === 'editor')"
        type="button"
        :disabled="!editorAvailable"
        :aria-pressed="workspaceMode === 'editor'"
        title="Show open editor tabs"
        @click="$emit('show-editor')"
      >
        <i class="mdi mdi-file-document-edit-outline" aria-hidden="true" />
        Editor
      </button>
    </div>

    <button class="btn btn-sm toolbar-button toolbar-toggle ms-1" type="button" title="Manage SSH/SFTP connections" @click="$emit('open-remote')">
      <i class="mdi mdi-server-network" aria-hidden="true" />
      Remote
    </button>

    <div class="toolbar-divider" />

    <div v-if="workspaceMode === 'files'" class="btn-group btn-group-sm" role="group" aria-label="Panel visibility">
      <button
        class="btn toolbar-button toolbar-toggle"
        :class="visibilityButtonClass(layout.leftVisible)"
        type="button"
        :aria-pressed="layout.leftVisible"
        title="Show or hide the left panel"
        @click="$emit('toggle-left')"
      >
        <i class="mdi mdi-dock-left" aria-hidden="true" />
        Left
      </button>
      <button
        class="btn toolbar-button toolbar-toggle"
        :class="visibilityButtonClass(layout.rightVisible)"
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
      class="btn btn-sm toolbar-button toolbar-toggle ms-1"
      :class="visibilityButtonClass(layout.terminalVisible)"
      type="button"
      :aria-pressed="layout.terminalVisible"
      title="Show or hide the terminal"
      @click="$emit('toggle-terminal')"
    >
      <i class="mdi mdi-console-line" aria-hidden="true" />
      Terminal
    </button>

    <div v-if="workspaceMode === 'files'" class="toolbar-divider" />

    <div v-if="workspaceMode === 'files'" class="btn-group btn-group-sm" role="group" aria-label="File operations">
      <div class="btn-group btn-group-sm">
        <button ref="createButton" class="btn toolbar-button toolbar-command dropdown-toggle" data-bs-toggle="dropdown" type="button" :disabled="!commandAvailability.create" aria-expanded="false">
          <i class="mdi mdi-plus" aria-hidden="true" /> Create
        </button>
        <ul class="dropdown-menu">
          <li><button class="dropdown-item" type="button" @click="selectCreate('file')"><i class="mdi mdi-file-plus-outline" aria-hidden="true" /> File</button></li>
          <li><button class="dropdown-item" type="button" @click="selectCreate('folder')"><i class="mdi mdi-folder-plus-outline" aria-hidden="true" /> Folder</button></li>
        </ul>
      </div>
      <button
        class="btn toolbar-button toolbar-command"
        type="button"
        :disabled="!commandAvailability.copy"
        aria-keyshortcuts="F5"
        title="Copy selected item to the other panel (F5)"
        @click="$emit('copy')"
      >
        <i class="mdi mdi-content-copy" aria-hidden="true" />
        <span class="commander-key">F5</span> Copy
      </button>
      <button
        class="btn toolbar-button toolbar-command"
        type="button"
        :disabled="!commandAvailability.move"
        aria-keyshortcuts="F6"
        title="Move selected item to the other panel (F6)"
        @click="$emit('move')"
      >
        <i class="mdi mdi-file-move-outline" aria-hidden="true" />
        <span class="commander-key">F6</span> Move
      </button>
      <button
        class="btn toolbar-button toolbar-command"
        type="button"
        :disabled="!commandAvailability.delete"
        aria-keyshortcuts="F8"
        title="Delete selected item (F8)"
        @click="$emit('delete')"
      >
        <i class="mdi mdi-delete-outline" aria-hidden="true" />
        <span class="commander-key">F8</span> Delete
      </button>
    </div>

    <button
      class="btn btn-sm toolbar-button ms-1"
      type="button"
      title="Open settings"
      @click="$emit('open-settings')"
    >
      <i class="mdi mdi-cog-outline" aria-hidden="true" />
      Settings
    </button>

    <div class="toolbar-spacer" />

    <div class="active-panel-indicator">
      <span>Active</span>
      <strong>{{ workspaceMode === 'editor' ? 'Editor' : activePanel }}</strong>
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
