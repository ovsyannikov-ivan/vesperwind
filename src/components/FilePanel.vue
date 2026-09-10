<script setup>
import { onMounted, ref } from 'vue'
import { useFilesystem } from '../composables/useFilesystem.js'
import FileTree from './FileTree.vue'

const props = defineProps({
  side: {
    type: String,
    required: true,
    validator: (value) => ['left', 'right'].includes(value),
  },
  active: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['activate', 'collapse'])
const { getRoot, listDirectory } = useFilesystem()
const root = ref(null)
const selectedPath = ref('')
const loading = ref(true)
const error = ref(null)

const loadRoot = async () => {
  loading.value = true
  error.value = null
  const response = await getRoot()
  loading.value = false

  if (!response?.ok) {
    error.value = response?.error || { message: 'Unable to load filesystem root' }
    return
  }

  root.value = response.root
}

const selectNode = (node) => {
  selectedPath.value = node.path
}

onMounted(loadRoot)
</script>

<template>
  <section
    class="file-panel"
    :class="{ 'is-active': active }"
    :aria-label="`${side} file panel`"
    @pointerdown="$emit('activate')"
  >
    <header class="panel-header">
      <div class="panel-title">
        <i class="mdi mdi-folder-multiple-outline" aria-hidden="true" />
        <strong>{{ side === 'left' ? 'Left' : 'Right' }}</strong>
        <span class="panel-path">{{ selectedPath || root?.path || 'Loading…' }}</span>
      </div>
      <button
        class="panel-action"
        type="button"
        :aria-label="`Hide ${side} panel`"
        :title="`Hide ${side} panel`"
        @click.stop="$emit('collapse')"
      >
        <i
          class="mdi"
          :class="side === 'left' ? 'mdi-chevron-left' : 'mdi-chevron-right'"
          aria-hidden="true"
        />
      </button>
    </header>

    <div class="panel-content">
      <div v-if="loading" class="panel-message">
        <i class="mdi mdi-loading mdi-spin" aria-hidden="true" />
        Reading root folder…
      </div>
      <div v-else-if="error" class="panel-message panel-message-error" role="alert">
        <i class="mdi mdi-alert-outline" aria-hidden="true" />
        <span>{{ error.message }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="loadRoot">
          Retry
        </button>
      </div>
      <FileTree
        v-else-if="root"
        :root="root"
        :selected-path="selectedPath"
        :list-directory="listDirectory"
        @select="selectNode"
      />
    </div>
  </section>
</template>
