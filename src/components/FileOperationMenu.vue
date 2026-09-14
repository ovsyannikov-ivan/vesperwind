<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  request: {
    type: Object,
    required: true,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  activeAction: {
    type: String,
    default: '',
  },
  error: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['select', 'cancel'])
const firstActionRef = ref(null)
const menuStyle = computed(() => {
  const width = 288
  const height = props.error ? 286 : 240
  const left = Math.max(8, Math.min(props.request.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(props.request.y, window.innerHeight - height - 8))

  return {
    left: `${left}px`,
    top: `${top}px`,
  }
})

const handleKeydown = (event) => {
  if (event.key === 'Escape' && !props.busy) {
    emit('cancel')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  await nextTick()
  firstActionRef.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="file-operation-menu-backdrop"
      aria-hidden="true"
      @pointerdown="$emit('cancel')"
    />
    <div
      class="dropdown-menu show file-operation-menu shadow"
      :style="menuStyle"
      role="menu"
      :aria-label="`Choose an action for ${request.source.name}`"
    >
      <h6 class="dropdown-header">
        Drop into “{{ request.target.name }}”
      </h6>
      <button
        ref="firstActionRef"
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('select', 'move')"
      >
        <i
          class="mdi"
          :class="activeAction === 'move' ? 'mdi-loading mdi-spin' : 'mdi-file-move-outline'"
          aria-hidden="true"
        />
        Move here
      </button>
      <button
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('select', 'copy')"
      >
        <i
          class="mdi"
          :class="activeAction === 'copy' ? 'mdi-loading mdi-spin' : 'mdi-content-copy'"
          aria-hidden="true"
        />
        Copy here
      </button>
      <button
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('select', 'link')"
      >
        <i
          class="mdi"
          :class="activeAction === 'link' ? 'mdi-loading mdi-spin' : 'mdi-link-variant-plus'"
          aria-hidden="true"
        />
        Create symbolic link
      </button>

      <div v-if="error" class="dropdown-item-text file-operation-error" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        <span>{{ error }}</span>
      </div>

      <div class="dropdown-divider" />
      <button
        class="dropdown-item"
        type="button"
        role="menuitem"
        :disabled="busy"
        @click="$emit('cancel')"
      >
        <i class="mdi mdi-close" aria-hidden="true" />
        Cancel
      </button>
    </div>
  </Teleport>
</template>
