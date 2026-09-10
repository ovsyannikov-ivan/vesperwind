import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'

const MIN_COLUMNS = 2
const MAX_COLUMNS = 500
const MIN_ROWS = 1
const MAX_ROWS = 300

const clampInteger = (value, minimum, maximum, fallback) => {
  const parsedValue = Number.parseInt(value, 10)

  if (!Number.isFinite(parsedValue)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, parsedValue))
}

const serializeTerminalError = (error) => ({
  code: error?.code || 'ETERMINAL',
  message: error?.message || 'Unable to start the terminal',
})

export const registerTerminalHandlers = (socket, { cwd }) => {
  let session = null

  const closeSession = () => {
    if (!session) {
      return
    }

    try {
      session.process.kill()
    } catch {
      // The PTY may already have exited.
    }

    session = null
  }

  socket.on('terminal:create', (payload, acknowledge) => {
    if (session) {
      acknowledge?.({ ok: true, id: session.id, reused: true })
      return
    }

    const shell = process.env.SHELL || '/bin/zsh'
    const columns = clampInteger(payload?.cols, MIN_COLUMNS, MAX_COLUMNS, 80)
    const rows = clampInteger(payload?.rows, MIN_ROWS, MAX_ROWS, 24)

    try {
      const terminalProcess = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: columns,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      })

      const id = randomUUID()
      session = { id, process: terminalProcess }

      terminalProcess.onData((data) => {
        socket.emit('terminal:output', { id, data })
      })

      terminalProcess.onExit(({ exitCode, signal }) => {
        socket.emit('terminal:exit', { id, exitCode, signal })

        if (session?.id === id) {
          session = null
        }
      })

      acknowledge?.({ ok: true, id, reused: false })
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeTerminalError(error) })
    }
  })

  socket.on('terminal:input', (payload) => {
    if (!session || payload?.id !== session.id || typeof payload?.data !== 'string') {
      return
    }

    session.process.write(payload.data)
  })

  socket.on('terminal:resize', (payload) => {
    if (!session || payload?.id !== session.id) {
      return
    }

    const columns = clampInteger(payload?.cols, MIN_COLUMNS, MAX_COLUMNS, 80)
    const rows = clampInteger(payload?.rows, MIN_ROWS, MAX_ROWS, 24)

    try {
      session.process.resize(columns, rows)
    } catch {
      // A resize can race with a shell process exiting.
    }
  })

  socket.on('terminal:close', (payload, acknowledge) => {
    if (session && (!payload?.id || payload.id === session.id)) {
      closeSession()
    }

    acknowledge?.({ ok: true })
  })

  socket.on('disconnect', closeSession)
}
