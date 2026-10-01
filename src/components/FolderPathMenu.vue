<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { navigateDropdown } from '../utils/dropdownNavigation.js'
import { getFileIcon } from '../utils/fileIcons.js'
import { findTypeaheadIndex, listSubfolders } from '../utils/folderMenu.js'

// Lists the subfolders of a breadcrumb folder through the panel's filesystem provider.
const props = defineProps({
  // { path, name, anchor: { left, bottom }, currentPath }
  request: { type: Object, required: true },
  listDirectory: { type: Function, required: true },
})

const emit = defineEmits(['select', 'cancel'])
const menuRef = ref(null)
const loading = ref(true)
const error = ref('')
const folders = ref([])
// The same icon and color as the folder in the file tree; the current one is open.
const folderIcon = (folder) => {
  const { icon, className } = getFileIcon(folder, folder.path === props.request.currentPath)
  return [icon, className]
}
const left = ref(props.request.anchor.left)
const top = computed(() => props.request.anchor.bottom + 3)
const menuStyle = computed(() => ({
  left: `${left.value}px`,
  top: `${top.value}px`,
  maxHeight: `${Math.max(120, window.innerHeight - top.value - 8)}px`,
}))
let typeahead = ''
let typeaheadTimer = null

const items = () => Array.from(menuRef.value?.querySelectorAll('.dropdown-item') || [])

const place = async () => {
  await nextTick()
  const width = menuRef.value?.offsetWidth || 0
  left.value = Math.max(8, Math.min(props.request.anchor.left, window.innerWidth - width - 8))
  menuRef.value?.querySelector('.dropdown-item.is-current')?.scrollIntoView({ block: 'nearest' })
}

const load = async () => {
  try {
    const response = await props.listDirectory(props.request.path)
    if (!response?.ok) {
      error.value = response?.error?.message || 'Unable to read this folder'
      return
    }
    folders.value = listSubfolders(response.entries)
  } catch (cause) {
    error.value = cause?.message || 'Unable to read this folder'
  } finally {
    loading.value = false
    await place()
  }
}

const handlePointerDown = (event) => {
  if (!menuRef.value?.contains(event.target)) emit('cancel')
}

const selectByTypeahead = (event) => {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === ' ' && !typeahead) return false // Space activates the focused item.
  const buttons = items()
  if (!buttons.length) return false
  clearTimeout(typeaheadTimer)
  typeahead += event.key
  typeaheadTimer = setTimeout(() => { typeahead = '' }, 700)
  const current = buttons.indexOf(document.activeElement)
  // A repeated first letter cycles; a longer prefix may stay on the current item.
  const from = typeahead.length > 1 ? current - 1 : current
  const index = findTypeaheadIndex(folders.value.map((folder) => folder.name), typeahead, from)
  if (index < 0) return true
  event.preventDefault()
  buttons[index].focus({ preventScroll: true })
  buttons[index].scrollIntoView({ block: 'nearest' })
  return true
}

const handleKeydown = (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (!menuRef.value?.contains(document.activeElement)) return
  // Keep panel shortcuts such as F5/F6/F8 away from the selection behind the menu.
  event.stopPropagation()
  if (navigateDropdown(event, menuRef.value)) {
    document.activeElement?.scrollIntoView({ block: 'nearest' })
    return
  }
  selectByTypeahead(event)
}

const closeOnResize = () => emit('cancel')
// Like a native menu, close when focus moves to another control (not on window blur).
const handleFocusOut = (event) => {
  if (event.relatedTarget && !menuRef.value?.contains(event.relatedTarget)) emit('cancel')
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('resize', closeOnResize)
  await place()
  menuRef.value?.focus({ preventScroll: true })
  void load()
})

onBeforeUnmount(() => {
  clearTimeout(typeaheadTimer)
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('resize', closeOnResize)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="dropdown-menu show folder-path-menu shadow"
      :style="menuStyle"
      role="menu"
      tabindex="-1"
      :aria-label="`Folders in ${request.name}`"
      :aria-busy="loading"
      @contextmenu.prevent
      @focusout="handleFocusOut"
    >
      <div v-if="loading" class="dropdown-item-text folder-path-menu-status">
        <span class="spinner-border spinner-border-sm" aria-hidden="true" />
        Loading…
      </div>
      <div v-else-if="error" class="dropdown-item-text folder-path-menu-status text-danger" role="alert">{{ error }}</div>
      <div v-else-if="!folders.length" class="dropdown-item-text folder-path-menu-status">No subfolders</div>
      <template v-else>
        <button
          v-for="folder in folders"
          :key="folder.path"
          class="dropdown-item"
          :class="{ 'is-current': folder.path === request.currentPath }"
          type="button"
          role="menuitem"
          :aria-current="folder.path === request.currentPath ? 'location' : undefined"
          :title="folder.path"
          @click="emit('select', folder)"
        >
          <i class="mdi" :class="folderIcon(folder)" aria-hidden="true" />
          <span class="folder-path-menu-name">{{ folder.name }}</span>
          <i v-if="folder.path === request.currentPath" class="mdi mdi-check folder-path-menu-check" aria-hidden="true" />
        </button>
      </template>
    </div>
  </Teleport>
</template>
