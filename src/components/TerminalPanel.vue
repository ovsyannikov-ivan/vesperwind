<script setup>
import { computed, ref } from 'vue'
import { useTerminal } from '../composables/useTerminal.js'

const props = defineProps({
  visible: {
    type: Boolean,
    required: true,
  },
})

const emit = defineEmits(['toggle'])
const terminalContainer = ref(null)
const visible = computed(() => props.visible)
const { status, errorMessage, dropActive, restart } = useTerminal(
  terminalContainer,
  visible,
)

const statusLabel = computed(() => {
  const labels = {
    connecting: 'Starting shell…',
    ready: 'Shell ready',
    disconnected: 'Backend offline',
    exited: 'Process exited',
    error: errorMessage.value || 'Terminal error',
  }

  return labels[status.value] || status.value
})
</script>

<template>
  <section class="terminal-panel" :class="{ 'is-collapsed': !visible }">
    <header class="terminal-header" @dblclick="$emit('toggle')">
      <div class="terminal-title">
        <i class="mdi mdi-console-line" aria-hidden="true" />
        <strong>Terminal</strong>
        <span class="terminal-status" :class="`status-${status}`">{{ statusLabel }}</span>
      </div>
      <div class="terminal-actions">
        <button
          v-if="['exited', 'error', 'disconnected'].includes(status)"
          class="panel-action"
          type="button"
          title="Start a new shell"
          aria-label="Start a new shell"
          @click.stop="restart"
        >
          <i class="mdi mdi-restart" aria-hidden="true" />
        </button>
        <button
          class="panel-action"
          type="button"
          :title="visible ? 'Collapse terminal' : 'Expand terminal'"
          :aria-label="visible ? 'Collapse terminal' : 'Expand terminal'"
          @click.stop="$emit('toggle')"
        >
          <i
            class="mdi"
            :class="visible ? 'mdi-chevron-down' : 'mdi-chevron-up'"
            aria-hidden="true"
          />
        </button>
      </div>
    </header>
    <div
      v-show="visible"
      ref="terminalContainer"
      class="terminal-container"
      :class="{ 'is-drop-target': dropActive }"
    />
  </section>
</template>
