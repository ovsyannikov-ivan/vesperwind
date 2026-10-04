import { reactive, watch } from 'vue'
import { verticalWorkspaceSizes } from '../player/workspaceSizing.js'

const STORAGE_KEY = 'vesperwind:layout:v1'

const defaults = {
  leftVisible: true,
  rightVisible: true,
  terminalVisible: true,
  leftRatio: 50,
  terminalHeight: 260,
  audioPlaylistExpanded: false,
  audioPlaylistHeight: 220,
}

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value))

const readStoredLayout = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

export const useLayout = () => {
  const stored = readStoredLayout()
  const layout = reactive({
    leftVisible:
      typeof stored.leftVisible === 'boolean'
        ? stored.leftVisible
        : defaults.leftVisible,
    rightVisible:
      typeof stored.rightVisible === 'boolean'
        ? stored.rightVisible
        : defaults.rightVisible,
    terminalVisible:
      typeof stored.terminalVisible === 'boolean'
        ? stored.terminalVisible
        : defaults.terminalVisible,
    leftRatio: clamp(Number(stored.leftRatio) || defaults.leftRatio, 20, 80),
    audioPlaylistExpanded: typeof stored.audioPlaylistExpanded === 'boolean' ? stored.audioPlaylistExpanded : defaults.audioPlaylistExpanded,
    audioPlaylistHeight: clamp(Number(stored.audioPlaylistHeight) || defaults.audioPlaylistHeight, 80, 800),
    terminalHeight: clamp(
      Number(stored.terminalHeight) || defaults.terminalHeight,
      120,
      800,
    ),
  })

  watch(
    layout,
    (nextLayout) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextLayout))
    },
    { deep: true },
  )

  const toggleLeft = () => {
    layout.leftVisible = !layout.leftVisible
  }

  const toggleRight = () => {
    layout.rightVisible = !layout.rightVisible
  }

  const toggleTerminal = () => {
    layout.terminalVisible = !layout.terminalVisible
  }

  const setLeftRatio = (ratio) => {
    layout.leftRatio = clamp(ratio, 20, 80)
  }

  const sizes = (availableHeight, playlistVisible) => verticalWorkspaceSizes({ availableHeight,
    terminalVisible: layout.terminalVisible, playlistVisible, terminalHeight: layout.terminalHeight,
    playlistHeight: layout.audioPlaylistHeight })
  const setTerminalHeight = (height, availableHeight = Infinity, playlistVisible = false) => {
    const effective = sizes(availableHeight, playlistVisible)
    layout.terminalHeight = clamp(height, Math.min(120, effective.budget - effective.playlist), Math.min(800, effective.budget - effective.playlist))
  }
  const setAudioPlaylistHeight = (height, availableHeight, playlistVisible = true) => {
    const effective = sizes(availableHeight, playlistVisible)
    const maximum = Math.max(0, effective.budget - (layout.terminalVisible ? effective.terminal : 0))
    layout.audioPlaylistHeight = clamp(height, Math.min(80, maximum), Math.min(800, maximum))
  }

  return {
    layout,
    toggleLeft,
    toggleRight,
    toggleTerminal,
    setLeftRatio,
    setTerminalHeight,
    setAudioPlaylistHeight,
  }
}
