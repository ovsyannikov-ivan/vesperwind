import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { connection } from '../api/connection.js'
import { terminal as terminalApi } from '../api/terminal.js'
import { createTerminalAnsiNormalizer } from '../utils/terminalAnsi.js'
import { TERMINAL_PATH_MIME } from '../utils/terminalPath.js'

const DARK_TERMINAL_THEME = {
  background: '#161616',
  foreground: '#e5e5ea',
  cursor: '#0a84ff',
  cursorAccent: '#161616',
  selectionBackground: '#0a84ff66',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#3a3a3caa',
  black: '#1c1c1e',
  brightBlack: '#3a3a3c',
  red: '#ff453a',
  brightRed: '#ff6961',
  green: '#30d158',
  brightGreen: '#6ada72',
  yellow: '#ffd60a',
  brightYellow: '#ffdf5d',
  blue: '#0a84ff',
  brightBlue: '#409cff',
  magenta: '#bf5af2',
  brightMagenta: '#da8fff',
  cyan: '#64d2ff',
  brightCyan: '#70d7ff',
  white: '#e5e5ea',
  brightWhite: '#ffffff',
}

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#007aff',
  cursorAccent: '#ffffff',
  selectionBackground: '#007aff3d',
  selectionForeground: '#1d1d1f',
  selectionInactiveBackground: '#d1d1d699',
  black: '#1d1d1f',
  brightBlack: '#8e8e93',
  red: '#d70015',
  brightRed: '#ff3b30',
  green: '#248a3d',
  brightGreen: '#34c759',
  yellow: '#8a6d00',
  brightYellow: '#a28400',
  blue: '#0071e3',
  brightBlue: '#007aff',
  magenta: '#8944ab',
  brightMagenta: '#af52de',
  cyan: '#007c91',
  brightCyan: '#32ade6',
  white: '#d1d1d6',
  brightWhite: '#ffffff',
}

const getTerminalTheme = (theme) =>
  theme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME

export const useTerminal = (containerRef, visibleRef, sessionOptions = {}) => {
  const status = ref('connecting')
  const errorMessage = ref('')
  const sessionId = ref(null)
  const dropActive = ref(false)
  let terminal = null
  let fitAddon = null
  let resizeObserver = null
  let inputSubscription = null
  let unsubscribeData = null
  let unsubscribeExit = null
  let unsubscribeConnection = null
  let creatingSession = false
  let normalizeTerminalOutput = createTerminalAnsiNormalizer()

  const fit = () => {
    if (!terminal || !fitAddon || !visibleRef.value || !containerRef.value) {
      return
    }

    try {
      fitAddon.fit()

      if (sessionId.value) {
        terminalApi.resize(sessionId.value, terminal.cols, terminal.rows)
      }
    } catch {
      // xterm cannot be measured while its container is hidden.
    }
  }

  const createSession = async () => {
    if (!terminal || creatingSession || sessionId.value) {
      return
    }

    creatingSession = true
    status.value = 'connecting'
    errorMessage.value = ''

    const response = await terminalApi.createSession({
      cols: terminal.cols,
      rows: terminal.rows,
      type: sessionOptions.type || 'local',
      connectionId: sessionOptions.connectionId || null,
    })
    creatingSession = false

    if (!response?.ok) {
      status.value = 'error'
      errorMessage.value = response?.error?.message || 'Unable to reach the terminal backend'
      terminal.writeln(`\r\n\x1b[31m[${errorMessage.value}]\x1b[0m`)
      return
    }

    sessionId.value = response.sessionId
    if (response.title) sessionOptions.onTitle?.(response.title)
    status.value = 'ready'
    fit()
  }

  const handleOutput = (payload) => {
    if (!terminal || typeof payload?.data !== 'string') {
      return
    }

    if (sessionId.value && payload.sessionId === sessionId.value) {
      terminal.write(normalizeTerminalOutput(payload.data))
    }
  }

  const handleExit = (payload) => {
    if (payload?.sessionId !== sessionId.value) {
      return
    }

    sessionId.value = null
    status.value = payload.disconnected ? 'disconnected' : 'exited'
    terminal?.writeln(payload.disconnected
      ? '\r\n\x1b[31m[SSH connection disconnected]\x1b[0m'
      : `\r\n\x1b[90m[Process exited with code ${payload.exitCode}]\x1b[0m`)
  }

  const handleConnect = () => {
    createSession()
  }

  const handleDisconnect = () => {
    sessionId.value = null
    creatingSession = false
    normalizeTerminalOutput = createTerminalAnsiNormalizer()
    status.value = 'disconnected'
  }

  const handleThemeChange = (event) => {
    if (terminal) {
      terminal.options.theme = getTerminalTheme(event.detail?.theme)
    }
  }

  const restart = () => {
    if (status.value === 'ready') {
      terminal?.focus()
      return
    }

    terminal?.clear()
    createSession()
  }

  const carriesTerminalPath = (event) =>
    Array.from(event.dataTransfer?.types || []).includes(TERMINAL_PATH_MIME)

  const handleDragOver = (event) => {
    if (!carriesTerminalPath(event)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    dropActive.value = true
  }

  const handleDragLeave = (event) => {
    if (containerRef.value?.contains(event.relatedTarget)) {
      return
    }

    dropActive.value = false
  }

  const handleDrop = (event) => {
    dropActive.value = false

    if (!carriesTerminalPath(event) || !sessionId.value) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const value = event.dataTransfer.getData(TERMINAL_PATH_MIME)

    if (!value) {
      return
    }

    terminalApi.write(sessionId.value, value)
    terminal?.focus()
  }

  onMounted(() => {
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      fontSize: 14,
      scrollback: 5_000,
      theme: getTerminalTheme(document.documentElement.dataset.bsTheme),
    })
    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.value)
    containerRef.value.addEventListener('dragover', handleDragOver, true)
    containerRef.value.addEventListener('dragleave', handleDragLeave, true)
    containerRef.value.addEventListener('drop', handleDrop, true)
    inputSubscription = terminal.onData((data) => {
      if (sessionId.value) {
        terminalApi.write(sessionId.value, data)
      }
    })

    unsubscribeData = terminalApi.onData(handleOutput)
    unsubscribeExit = terminalApi.onExit(handleExit)
    unsubscribeConnection = connection.onStatusChange((isConnected) => {
      if (isConnected) {
        handleConnect()
      } else {
        handleDisconnect()
      }
    })
    window.addEventListener('vesperwind:theme-changed', handleThemeChange)

    resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(containerRef.value)

    nextTick(() => {
      fit()
      createSession()
    })
  })

  watch(
    visibleRef,
    async (isVisible) => {
      if (!isVisible) {
        return
      }

      await nextTick()
      fit()
      terminal?.focus()
    },
  )

  onBeforeUnmount(() => {
    if (sessionId.value) {
      terminalApi.closeSession(sessionId.value)
    }

    unsubscribeData?.()
    unsubscribeExit?.()
    unsubscribeConnection?.()
    window.removeEventListener('vesperwind:theme-changed', handleThemeChange)
    containerRef.value?.removeEventListener('dragover', handleDragOver, true)
    containerRef.value?.removeEventListener('dragleave', handleDragLeave, true)
    containerRef.value?.removeEventListener('drop', handleDrop, true)
    resizeObserver?.disconnect()
    inputSubscription?.dispose()
    terminal?.dispose()
  })

  return {
    status,
    errorMessage,
    dropActive,
    fit,
    restart,
    sessionId,
  }
}
