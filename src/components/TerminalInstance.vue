<script setup>
import { computed, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal.js'

const props = defineProps({ visible: Boolean, type: { type: String, default: 'local' }, connectionId: { type: String, default: null } })
const emit = defineEmits(['status', 'title'])
const container = ref(null)
const visible = computed(() => props.visible)
const { status, errorMessage, dropActive, restart, activate } = useTerminal(container, visible, {
  type: props.type,
  connectionId: props.connectionId,
  onTitle: (title) => emit('title', title),
})
watch([status, errorMessage], () => emit('status', { status: status.value, error: errorMessage.value }), { immediate: true })
defineExpose({ restart, activate })
</script>

<template>
  <div v-show="visible" ref="container" class="terminal-container" :class="{ 'is-drop-target': dropActive }" />
</template>
