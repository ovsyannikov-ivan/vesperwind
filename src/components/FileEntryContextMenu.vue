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
  // { canCut, canCopy, canPaste, pasteLabel, shortcuts: { cut, copy, paste } }
  clipboard: { type: Object, default: null },
  // Right-click on empty panel space: only folder-level actions.
  background: { type: Boolean, default: false },
  // { mounted: true | false | null (unknown), busy }
  diskImage: { type: Object, default: null },
})

const emit = defineEmits(['open', 'system-open', 'open-with', 'reveal', 'rename', 'delete', 'cancel', 'archive-create', 'archive-extract', 'cut', 'copy', 'paste', 'duplicate', 'mount-image', 'unmount-image'])
const menuRef = ref(null)
const menuStyle = computed(() => {
  const width = 240
  const nativeFile = props.nativeActions && !props.request.node.isDirectory
  const clipboardRows = props.clipboard ? (props.background ? 1 : 4) : 0
  const rows = props.background ? clipboardRows : 2 + Number(Boolean(props.openAction)) + Number(props.archiveActions) + Number(props.archiveActions && archiveName(props.request.node.name) && !props.request.node.isDirectory) + 2 * Number(props.nativeActions) +
    Number(nativeFile && props.openWithAvailable) + clipboardRows + Number(Boolean(props.diskImage))
  const height = 16 + rows * 33 + (props.openAction || props.nativeActions ? 9 : 0) +
    (props.clipboard && !props.background ? 18 : 0) + (props.diskImage ? 9 : 0) + (props.error ? 52 : 0)
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
      :aria-label="background ? `Actions for folder ${request.node.name}` : `Actions for ${request.node.name}`"
      @contextmenu.prevent
    >
      <template v-if="!background">
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
      <template v-if="clipboard">
        <button class="dropdown-item" type="button" role="menuitem" :disabled="busy || !clipboard.canCut" @click="$emit('cut')">
          <i class="mdi mdi-content-cut" aria-hidden="true" /> Cut
          <span class="dropdown-item-shortcut" aria-hidden="true">{{ clipboard.shortcuts.cut }}</span>
        </button>
        <button class="dropdown-item" type="button" role="menuitem" :disabled="busy || !clipboard.canCopy" @click="$emit('copy')">
          <i class="mdi mdi-content-copy" aria-hidden="true" /> Copy
          <span class="dropdown-item-shortcut" aria-hidden="true">{{ clipboard.shortcuts.copy }}</span>
        </button>
        <button class="dropdown-item" type="button" role="menuitem" :disabled="busy || !clipboard.canPaste" @click="$emit('paste')">
          <i class="mdi mdi-content-paste" aria-hidden="true" /> {{ clipboard.pasteLabel }}
          <span class="dropdown-item-shortcut" aria-hidden="true">{{ clipboard.shortcuts.paste }}</span>
        </button>
        <div class="dropdown-divider" />
        <button class="dropdown-item" type="button" role="menuitem" :disabled="busy || !clipboard.canCopy" @click="$emit('duplicate')">
          <i class="mdi mdi-content-duplicate" aria-hidden="true" /> Duplicate
        </button>
        <div class="dropdown-divider" />
      </template>
      <template v-if="diskImage">
        <button v-if="diskImage.mounted" class="dropdown-item" type="button" role="menuitem" :disabled="busy" @click="$emit('unmount-image')">
          <i class="mdi" :class="busy ? 'mdi-loading mdi-spin' : 'mdi-eject-outline'" aria-hidden="true" /> Eject Disk Image
        </button>
        <button v-else class="dropdown-item" type="button" role="menuitem" :disabled="busy || diskImage.mounted === null" @click="$emit('mount-image')">
          <i class="mdi" :class="busy || diskImage.mounted === null ? 'mdi-loading mdi-spin' : 'mdi-disc'" aria-hidden="true" /> Mount Disk Image
        </button>
        <div class="dropdown-divider" />
      </template>
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
      </template>
      <template v-else-if="clipboard">
        <button class="dropdown-item" type="button" role="menuitem" :disabled="busy || !clipboard.canPaste" @click="$emit('paste')">
          <i class="mdi mdi-content-paste" aria-hidden="true" /> Paste
          <span class="dropdown-item-shortcut" aria-hidden="true">{{ clipboard.shortcuts.paste }}</span>
        </button>
        <div v-if="error" class="px-3 py-2 small text-danger" role="alert">{{ error }}</div>
      </template>
    </div>
  </Teleport>
</template>
