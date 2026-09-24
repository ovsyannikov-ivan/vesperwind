<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettings } from '../composables/useSettings.js'
import {
  closeTerminalTab,
  createTerminalTab,
} from '../utils/terminalTabs.js'
import TerminalInstance from './TerminalInstance.vue'

defineProps({ visible: { type: Boolean, required: true } })
const emit = defineEmits(['toggle', 'manage-connections'])
const { settings } = useSettings()
const tabs = ref([])
const activeId = ref(null)
const addButton = ref(null)
const menuRef = ref(null)
const firstActionRef = ref(null)
const menuOpen = ref(false)
const menuStyle = ref({})
const instances = ref({})
let sequence = 0
let localSequence = 0
const profiles = computed(() => settings.value.connections || [])
const positionMenu = () => {
  const bounds = addButton.value?.getBoundingClientRect()
  if (!bounds) return
  const width = 240
  const estimatedHeight = Math.min(320, 142 + profiles.value.length * 30)
  const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - estimatedHeight - 8))
  menuStyle.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` }
}
const closeMenu = () => { menuOpen.value = false }
const toggleMenu = async () => {
  menuOpen.value = !menuOpen.value
  if (!menuOpen.value) return
  positionMenu()
  await nextTick()
  firstActionRef.value?.focus()
}
const activate = async (id) => {
  activeId.value = id
  await nextTick()
  instances.value[id]?.activate()
}
const add = async (type = 'local', profile = null) => {
  const id = `terminal-${++sequence}`
  if (type === 'local') localSequence += 1
  tabs.value.push(createTerminalTab({
    id,
    type,
    profile,
    localNumber: localSequence,
  }))
  closeMenu()
  await activate(id)
}
const close = (id) => {
  const nextState = closeTerminalTab(tabs.value, activeId.value, id)
  tabs.value = nextState.tabs
  activeId.value = nextState.activeId
  if (!tabs.value.length) add()
  else if (activeId.value) nextTick(() => instances.value[activeId.value]?.activate())
}
const updateStatus = (tab, value) => Object.assign(tab, value)
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value) || null)
const restart = () => activeTab.value && instances.value[activeTab.value.id]?.restart()
const setInstance = (id, value) => {
  if (value) instances.value[id] = value
  else delete instances.value[id]
}
const manageConnections = () => {
  closeMenu()
  emit('manage-connections')
}
const handlePointerDown = (event) => {
  if (!addButton.value?.contains(event.target) && !menuRef.value?.contains(event.target)) {
    closeMenu()
  }
}
const handleKeydown = (event) => {
  if (event.key === 'Escape') closeMenu()
}
onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', positionMenu)
  add()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', positionMenu)
})
</script>

<template>
  <section class="terminal-panel" :class="{ 'is-collapsed': !visible }">
    <header class="terminal-header" @dblclick="$emit('toggle')">
      <div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">
        <button v-for="tab in tabs" :key="tab.id" class="terminal-tab" :class="{ 'is-active': activeId === tab.id }" type="button" role="tab" :aria-selected="activeId === tab.id" :title="tab.error || tab.title" @click.stop="activate(tab.id)">
          <span class="terminal-tab-status" :class="`status-${tab.status}`" />
          <span class="text-truncate">{{ tab.title }}<template v-if="tab.status === 'disconnected'"> — Disconnected</template><template v-else-if="tab.status === 'error'"> — Error</template></span>
          <span
            class="tab-close"
            role="button"
            tabindex="0"
            aria-label="Close terminal"
            title="Close terminal"
            @click.stop="close(tab.id)"
            @keydown.enter.stop="close(tab.id)"
            @keydown.space.prevent.stop="close(tab.id)"
          >
            <i class="mdi mdi-close" aria-hidden="true" />
          </span>
        </button>
        <button ref="addButton" class="terminal-add-button" type="button" :aria-expanded="menuOpen" aria-haspopup="menu" title="New terminal" aria-label="New terminal" @click.stop="toggleMenu" @dblclick.stop><i class="mdi mdi-plus" aria-hidden="true" /></button>
      </div>
      <div class="terminal-actions">
        <button v-if="['disconnected', 'exited', 'error'].includes(activeTab?.status)" class="panel-action" type="button" :title="activeTab?.status === 'disconnected' ? 'Start a new remote shell' : 'Start a new shell'" :aria-label="activeTab?.status === 'disconnected' ? 'Reconnect terminal' : 'Restart terminal'" @click.stop="restart"><i class="mdi mdi-restart" aria-hidden="true" /></button>
        <button class="panel-action" type="button" :title="visible ? 'Collapse terminal' : 'Expand terminal'" :aria-label="visible ? 'Collapse terminal' : 'Expand terminal'" @click.stop="$emit('toggle')"><i class="mdi" :class="visible ? 'mdi-chevron-down' : 'mdi-chevron-up'" aria-hidden="true" /></button>
      </div>
    </header>
    <div v-show="visible" class="terminal-workspace">
      <TerminalInstance v-for="tab in tabs" :key="tab.id" :ref="(value) => setInstance(tab.id, value)" :visible="activeId === tab.id" :type="tab.type" :connection-id="tab.connectionId" @status="updateStatus(tab, $event)" />
    </div>
    <Teleport to="body">
      <ul v-if="menuOpen" ref="menuRef" class="dropdown-menu show terminal-new-menu shadow" :style="menuStyle" role="menu" aria-label="Create terminal">
        <li><button ref="firstActionRef" class="dropdown-item" type="button" role="menuitem" @click="add('local')"><i class="mdi mdi-console" aria-hidden="true" /> Local Terminal</button></li>
        <li><hr class="dropdown-divider"></li>
        <li><h2 class="dropdown-header">REMOTE</h2></li>
        <li v-for="profile in profiles" :key="profile.id"><button class="dropdown-item" type="button" role="menuitem" @click="add('ssh', profile)"><i class="mdi mdi-server-network" aria-hidden="true" /> {{ profile.name }}</button></li>
        <li v-if="!profiles.length"><span class="dropdown-item-text text-body-secondary">No saved connections</span></li>
        <li><hr class="dropdown-divider"></li>
        <li><button class="dropdown-item" type="button" role="menuitem" @click="manageConnections"><i class="mdi mdi-cog-outline" aria-hidden="true" /> Manage Connections…</button></li>
      </ul>
    </Teleport>
  </section>
</template>
