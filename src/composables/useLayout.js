import { reactive, watch } from 'vue'

const STORAGE_KEY = 'pelorus:layout:v1'

const defaults = {
  leftVisible: true,
  rightVisible: true,
  terminalVisible: true,
  leftRatio: 50,
  terminalHeight: 260,
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

  const setTerminalHeight = (height, availableHeight = Number.POSITIVE_INFINITY) => {
    const maximum = Math.max(120, Math.min(800, availableHeight - 140))
    layout.terminalHeight = clamp(height, 120, maximum)
  }

  return {
    layout,
    toggleLeft,
    toggleRight,
    toggleTerminal,
    setLeftRatio,
    setTerminalHeight,
  }
}
