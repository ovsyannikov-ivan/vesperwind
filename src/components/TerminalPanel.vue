<script setup>
import Dropdown from 'bootstrap/js/dist/dropdown'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettings } from '../composables/useSettings.js'
import TerminalInstance from './TerminalInstance.vue'

defineProps({ visible: { type: Boolean, required: true } })
defineEmits(['toggle'])
const { settings } = useSettings()
const tabs = ref([])
const activeId = ref(null)
const addButton = ref(null)
const instances = ref({})
let dropdown
let sequence = 0
const profiles = computed(() => settings.value.connections || [])
const add = (type = 'local', profile = null) => {
  const id = `terminal-${++sequence}`
  tabs.value.push({ id, type, connectionId: profile?.id || null, title: type === 'local' ? `Local ${sequence}` : `${profile.username}@${profile.host}`, status: 'connecting', error: '' })
  activeId.value = id
  dropdown?.hide()
}
const close = (id) => {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  tabs.value.splice(index, 1)
  if (activeId.value === id) activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || null
  if (!tabs.value.length) add()
}
const updateStatus = (tab, value) => Object.assign(tab, value)
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value) || null)
const restart = () => activeTab.value && instances.value[activeTab.value.id]?.restart()
const setInstance = (id, value) => {
  if (value) instances.value[id] = value
  else delete instances.value[id]
}
onMounted(() => { dropdown = new Dropdown(addButton.value); add() })
onBeforeUnmount(() => dropdown?.dispose())
</script>

<template>
  <section class="terminal-panel" :class="{ 'is-collapsed': !visible }">
    <header class="terminal-header" @dblclick="$emit('toggle')">
      <div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">
        <button v-for="tab in tabs" :key="tab.id" class="terminal-tab" :class="{ 'is-active': activeId === tab.id }" type="button" role="tab" :aria-selected="activeId === tab.id" :title="tab.error || tab.title" @click.stop="activeId = tab.id">
          <span class="terminal-tab-status" :class="`status-${tab.status}`" />
          <span class="text-truncate">{{ tab.title }}<template v-if="tab.status === 'disconnected'"> — Disconnected</template><template v-else-if="tab.status === 'error'"> — Error</template></span>
          <span class="terminal-tab-close" role="button" aria-label="Close terminal" title="Close terminal" @click.stop="close(tab.id)">×</span>
        </button>
        <div class="dropdown">
          <button ref="addButton" class="terminal-add-button" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="New terminal" aria-label="New terminal"><i class="mdi mdi-plus" aria-hidden="true" /></button>
          <ul class="dropdown-menu">
            <li><button class="dropdown-item" type="button" @click="add('local')"><i class="mdi mdi-console" aria-hidden="true" /> New Local Terminal</button></li>
            <li v-if="profiles.length"><hr class="dropdown-divider"></li>
            <li v-for="profile in profiles" :key="profile.id"><button class="dropdown-item" type="button" @click="add('ssh', profile)"><i class="mdi mdi-server-network" aria-hidden="true" /> {{ profile.name }}</button></li>
          </ul>
        </div>
      </div>
      <div class="terminal-actions">
        <button v-if="['disconnected', 'exited', 'error'].includes(activeTab?.status)" class="panel-action" type="button" :title="activeTab?.status === 'disconnected' ? 'Start a new remote shell' : 'Start a new shell'" :aria-label="activeTab?.status === 'disconnected' ? 'Reconnect terminal' : 'Restart terminal'" @click.stop="restart"><i class="mdi mdi-restart" aria-hidden="true" /></button>
        <button class="panel-action" type="button" :title="visible ? 'Collapse terminal' : 'Expand terminal'" :aria-label="visible ? 'Collapse terminal' : 'Expand terminal'" @click.stop="$emit('toggle')"><i class="mdi" :class="visible ? 'mdi-chevron-down' : 'mdi-chevron-up'" aria-hidden="true" /></button>
      </div>
    </header>
    <div v-show="visible" class="terminal-workspace">
      <TerminalInstance v-for="tab in tabs" :key="tab.id" :ref="(value) => setInstance(tab.id, value)" :visible="activeId === tab.id" :type="tab.type" :connection-id="tab.connectionId" @status="updateStatus(tab, $event)" @title="tab.title = $event" />
    </div>
  </section>
</template>
