import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { socket } from '../socket/socket.js'

const TERMINAL_THEME = {
  background: '#0b0f14',
  foreground: '#d8dee9',
  cursor: '#62d6a8',
  cursorAccent: '#0b0f14',
  selectionBackground: '#36536f99',
  black: '#182029',
  brightBlack: '#5b6773',
  red: '#ff6b72',
  brightRed: '#ff8b91',
  green: '#62d6a8',
  brightGreen: '#80e6bc',
  yellow: '#e7c66b',
  brightYellow: '#f2d984',
  blue: '#70a8e8',
  brightBlue: '#8abcf1',
  magenta: '#c792ea',
  brightMagenta: '#d8a8f3',
  cyan: '#67c7d4',
  brightCyan: '#83dce7',
  white: '#d8dee9',
  brightWhite: '#ffffff',
}

export const useTerminal = (containerRef, visibleRef) => {
  const status = ref('connecting')
  const errorMessage = ref('')
  const sessionId = ref(null)
  let terminal = null
  let fitAddon = null
  let resizeObserver = null
  let inputSubscription = null
  let creatingSession = false

  const fit = () => {
    if (!terminal || !fitAddon || !visibleRef.value || !containerRef.value) {
      return
    }

    try {
      fitAddon.fit()

      if (sessionId.value) {
        socket.emit('terminal:resize', {
          id: sessionId.value,
          cols: terminal.cols,
          rows: terminal.rows,
        })
      }
    } catch {
      // xterm cannot be measured while its container is hidden.
    }
  }

  const createSession = () => {
    if (!terminal || creatingSession || sessionId.value) {
      return
    }

    creatingSession = true
    status.value = 'connecting'
    errorMessage.value = ''

    socket.timeout(15_000).emit(
      'terminal:create',
      { cols: terminal.cols, rows: terminal.rows },
      (timeoutError, response) => {
        creatingSession = false

        if (timeoutError || !response?.ok) {
          status.value = 'error'
          errorMessage.value = response?.error?.message || 'Unable to reach the terminal backend'
          return
        }

        sessionId.value = response.id
        status.value = 'ready'
        fit()
      },
    )
  }

  const handleOutput = (payload) => {
    if (!terminal || typeof payload?.data !== 'string') {
      return
    }

    if (!sessionId.value || payload.id === sessionId.value) {
      terminal.write(payload.data)
    }
  }

  const handleExit = (payload) => {
    if (payload?.id !== sessionId.value) {
      return
    }

    sessionId.value = null
    status.value = 'exited'
    terminal?.writeln(`\r\n\x1b[90m[Process exited with code ${payload.exitCode}]\x1b[0m`)
  }

  const handleConnect = () => {
    createSession()
  }

  const handleDisconnect = () => {
    sessionId.value = null
    creatingSession = false
    status.value = 'disconnected'
  }

  const restart = () => {
    if (status.value === 'ready') {
      terminal?.focus()
      return
    }

    terminal?.clear()
    createSession()
  }

  onMounted(() => {
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.12,
      scrollback: 5_000,
      theme: TERMINAL_THEME,
    })
    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.value)
    inputSubscription = terminal.onData((data) => {
      if (sessionId.value) {
        socket.emit('terminal:input', { id: sessionId.value, data })
      }
    })

    socket.on('terminal:output', handleOutput)
    socket.on('terminal:exit', handleExit)
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)

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
      socket.emit('terminal:close', { id: sessionId.value })
    }

    socket.off('terminal:output', handleOutput)
    socket.off('terminal:exit', handleExit)
    socket.off('connect', handleConnect)
    socket.off('disconnect', handleDisconnect)
    resizeObserver?.disconnect()
    inputSubscription?.dispose()
    terminal?.dispose()
  })

  return {
    status,
    errorMessage,
    fit,
    restart,
  }
}
