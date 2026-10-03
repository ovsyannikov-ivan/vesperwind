<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { isFilesystemRootEntry } from '../../shared/localFilesystem.js'
import { navigateDropdown } from '../utils/dropdownNavigation.js'
import { archiveName } from '../../shared/archivePolicy.js'

const props = defineProps({
  request: {
    type: Object,
    required: true,
  },
  openAction: {
    type: String,
    default: null,
    validator: (value) => value === null || ['open', 'edit', 'view'].includes(value),
  },
  nativeActions: { type: Boolean, default: false },
  archiveActions: { type: Boolean, default: false },
  openWithAvailable: { type: Boolean, default: false },
  revealLabel: { type: String, default: 'Show in File Manager' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['open', 'system-open', 'open-with', 'reveal', 'rename', 'delete', 'cancel', 'archive-create', 'archive-extract'])
const menuRef = ref(null)
const menuStyle = computed(() => {
  const width = 208
  const nativeFile = props.nativeActions && !props.request.node.isDirectory
  const rows = 2 + Number(Boolean(props.openAction)) + Number(props.archiveActions) + Number(props.archiveActions && archiveName(props.request.node.name) && !props.request.node.isDirectory) + 2 * Number(props.nativeActions) +
    Number(nativeFile && props.openWithAvailable)
  const height = 16 + rows * 33 + (props.openAction || props.nativeActions ? 9 : 0) +
    (props.error ? 52 : 0)
  const left = Math.max(8, Math.min(props.request.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(props.request.y, window.innerHeight - height - 8))

  return { left: `${left}px`, top: `${top}px` }
})
const actionIcon = computed(() => ({
  open: 'mdi-folder-open-outline',
  edit: 'mdi-file-edit-outline',
  view: 'mdi-eye-outline',
}[props.openAction]))
const actionLabel = computed(() => ({
  open: 'Open',
  edit: 'Edit',
  view: 'View',
}[props.openAction]))
const handlePointerDown = (event) => {
  if (!menuRef.value?.contains(event.target)) {
    emit('cancel')
  }
}

const handleKeydown = (event) => {
  if (navigateDropdown(event, menuRef.value)) return
  if (event.key === 'Escape') {
    emit('cancel')
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('keydown', handleKeydown)
  await nextTick()
  menuRef.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="dropdown-menu show file-entry-context-menu shadow"
      :style="menuStyle"
      role="menu"
      tabindex="-1"
      :aria-label="`Actions for ${request.node.name}`"
      @contextmenu.prevent
    >
      <button
        v-if="nativeActions"
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('system-open')"
      >
        <i class="mdi mdi-open-in-new" aria-hidden="true" />
        Open
      </button>
      <button
        v-if="nativeActions && openWithAvailable && !request.node.isDirectory"
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('open-with')"
      >
        <i class="mdi mdi-application-outline" aria-hidden="true" />
        Open With…
      </button>
      <button
        v-if="openAction"
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('open')"
      >
        <i class="mdi" :class="actionIcon" aria-hidden="true" />
        {{ nativeActions && request.node.isDirectory ? 'Open in Panel' : actionLabel }}
      </button>
      <button
        v-if="nativeActions"
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('reveal')"
      >
        <i class="mdi mdi-folder-search-outline" aria-hidden="true" />
        {{ revealLabel }}
      </button>
      <div v-if="openAction || nativeActions" class="dropdown-divider" />
      <div v-if="error" class="px-3 py-2 small text-danger" role="alert">{{ error }}</div>
      <button v-if="archiveActions" class="dropdown-item" type="button" role="menuitem" :disabled="busy || isFilesystemRootEntry(request.node)" @click="$emit('archive-create')"><i class="mdi mdi-folder-zip-outline" aria-hidden="true" /> Create ZIP…</button>
      <button v-if="archiveActions && !request.node.isDirectory && archiveName(request.node.name)" class="dropdown-item" type="button" role="menuitem" :disabled="busy" @click="$emit('archive-extract')"><i class="mdi mdi-archive-arrow-down-outline" aria-hidden="true" /> Extract archive…</button>
      <button
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy || isFilesystemRootEntry(request.node)"
        @click="$emit('rename')"
      >
        <i class="mdi mdi-rename-outline" aria-hidden="true" />
        Rename
      </button>
      <button
        class="dropdown-item text-danger"
        type="button"
        role="menuitem"
        :disabled="busy || isFilesystemRootEntry(request.node)"
        @click="$emit('delete')"
      >
        <i class="mdi mdi-trash-can-outline" aria-hidden="true" />
        Delete
      </button>
    </div>
  </Teleport>
</template>
