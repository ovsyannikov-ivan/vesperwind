<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

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
})

const emit = defineEmits(['open', 'delete', 'cancel'])
const menuRef = ref(null)
const firstActionRef = ref(null)
const menuStyle = computed(() => {
  const width = 208
  const height = props.openAction ? 92 : 48
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
const captureDeleteRef = (element) => {
  if (!props.openAction) {
    firstActionRef.value = element
  }
}

const handlePointerDown = (event) => {
  if (!menuRef.value?.contains(event.target)) {
    emit('cancel')
  }
}

const handleKeydown = (event) => {
  if (event.key === 'Escape') {
    emit('cancel')
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('keydown', handleKeydown)
  await nextTick()
  firstActionRef.value?.focus()
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
      :aria-label="`Actions for ${request.node.name}`"
      @contextmenu.prevent
    >
      <button
        v-if="openAction"
        ref="firstActionRef"
        class="dropdown-item"
        type="button"
        role="menuitem"
        @click="$emit('open')"
      >
        <i class="mdi" :class="actionIcon" aria-hidden="true" />
        {{ actionLabel }}
      </button>
      <div v-if="openAction" class="dropdown-divider" />
      <button
        :ref="captureDeleteRef"
        class="dropdown-item text-danger"
        type="button"
        role="menuitem"
        @click="$emit('delete')"
      >
        <i class="mdi mdi-trash-can-outline" aria-hidden="true" />
        Delete
      </button>
    </div>
  </Teleport>
</template>
