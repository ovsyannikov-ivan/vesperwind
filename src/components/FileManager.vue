<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLayout } from '../composables/useLayout.js'
import { socket } from '../socket/socket.js'
import FilePanel from './FilePanel.vue'
import Splitter from './Splitter.vue'
import TerminalPanel from './TerminalPanel.vue'
import Toolbar from './Toolbar.vue'

const { layout, toggleLeft, toggleRight, toggleTerminal, setLeftRatio, setTerminalHeight } =
  useLayout()
const filesContainer = ref(null)
const workspace = ref(null)
const activePanel = ref('left')
const connected = ref(socket.connected)

const bothPanelsVisible = computed(() => layout.leftVisible && layout.rightVisible)
const terminalStyle = computed(() =>
  layout.terminalVisible ? { height: `${layout.terminalHeight}px` } : { height: '31px' },
)
const leftPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `calc(${layout.leftRatio}% - 3px)`, flex: '0 0 auto' }
})
const rightPanelStyle = computed(() => {
  if (!bothPanelsVisible.value) {
    return { flex: '1 1 auto' }
  }

  return { width: `calc(${100 - layout.leftRatio}% - 3px)`, flex: '0 0 auto' }
})

const activate = (side) => {
  activePanel.value = side
}

const hideLeft = () => {
  layout.leftVisible = false

  if (layout.rightVisible) {
    activePanel.value = 'right'
  }
}

const hideRight = () => {
  layout.rightVisible = false

  if (layout.leftVisible) {
    activePanel.value = 'left'
  }
}

const toggleLeftPanel = () => {
  toggleLeft()

  if (layout.leftVisible) {
    activePanel.value = 'left'
  } else if (layout.rightVisible) {
    activePanel.value = 'right'
  }
}

const toggleRightPanel = () => {
  toggleRight()

  if (layout.rightVisible) {
    activePanel.value = 'right'
  } else if (layout.leftVisible) {
    activePanel.value = 'left'
  }
}

const resizePanels = (delta) => {
  const width = filesContainer.value?.clientWidth

  if (!width) {
    return
  }

  setLeftRatio(layout.leftRatio + (delta / width) * 100)
}

const resizeTerminal = (delta) => {
  const availableHeight = workspace.value?.clientHeight || window.innerHeight
  setTerminalHeight(layout.terminalHeight - delta, availableHeight)
}

const clampTerminalToViewport = () => {
  const availableHeight = workspace.value?.clientHeight || window.innerHeight
  setTerminalHeight(layout.terminalHeight, availableHeight)
}

const handleConnect = () => {
  connected.value = true
}

const handleDisconnect = () => {
  connected.value = false
}

onMounted(() => {
  socket.on('connect', handleConnect)
  socket.on('disconnect', handleDisconnect)
  window.addEventListener('resize', clampTerminalToViewport)
  clampTerminalToViewport()
})

onBeforeUnmount(() => {
  socket.off('connect', handleConnect)
  socket.off('disconnect', handleDisconnect)
  window.removeEventListener('resize', clampTerminalToViewport)
})
</script>

<template>
  <main class="app-shell">
    <Toolbar
      :layout="layout"
      :active-panel="activePanel"
      :connected="connected"
      @toggle-left="toggleLeftPanel"
      @toggle-right="toggleRightPanel"
      @toggle-terminal="toggleTerminal"
    />

    <div ref="workspace" class="workspace">
      <div ref="filesContainer" class="files-container">
        <FilePanel
          v-if="layout.leftVisible"
          side="left"
          :active="activePanel === 'left'"
          :style="leftPanelStyle"
          @activate="activate('left')"
          @collapse="hideLeft"
        />

        <Splitter
          v-if="bothPanelsVisible"
          orientation="vertical"
          @resize="resizePanels"
        />

        <FilePanel
          v-if="layout.rightVisible"
          side="right"
          :active="activePanel === 'right'"
          :style="rightPanelStyle"
          @activate="activate('right')"
          @collapse="hideRight"
        />

        <div v-if="!layout.leftVisible && !layout.rightVisible" class="no-panels-message">
          <i class="mdi mdi-folder-open-outline" aria-hidden="true" />
          <span>Both file panels are hidden.</span>
          <button class="btn btn-sm btn-outline-light" type="button" @click="toggleLeftPanel">
            Show left panel
          </button>
        </div>
      </div>

      <Splitter
        v-if="layout.terminalVisible"
        orientation="horizontal"
        @resize="resizeTerminal"
      />

      <TerminalPanel
        :visible="layout.terminalVisible"
        :style="terminalStyle"
        @toggle="toggleTerminal"
      />
    </div>
  </main>
</template>
