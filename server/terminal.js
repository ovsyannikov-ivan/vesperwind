import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { sanitizeTerminalEnvironment } from './terminalEnvironment.js'

const MIN_COLUMNS = 2
const MAX_COLUMNS = 500
const MIN_ROWS = 1
const MAX_ROWS = 300
const DEFAULT_ZSH_PROMPT = '%n@%m %1~ %# '
const VESPERWIND_ZSH_PROMPT = '%F{green}%n@%m%f %F{blue}%1~%f %# '
// The final pair styles macOS dataless (cloud placeholder) files as
// default foreground on bright-black, which maps to a neutral grey in xterm.
const DEFAULT_LS_COLORS = 'ExGxFxDxxxExExBxBxExExxA'
const ZSH_STARTUP_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout']
let zshStartupDirectoryPromise = null
let zshStartupDirectory = null

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

const quoteZshValue = (value) => `'${value.replaceAll("'", "'\\''")}'`

const buildZshStartupFile = (originalDirectory, filename) => {
  const originalFile = path.join(originalDirectory, filename)
  const sourceUserConfiguration = [
    `if [[ -r ${quoteZshValue(originalFile)} ]]; then`,
    '  __vesperwind_zdotdir="$ZDOTDIR"',
    `  ZDOTDIR=${quoteZshValue(originalDirectory)}`,
    `  builtin source ${quoteZshValue(originalFile)}`,
    '  ZDOTDIR="$__vesperwind_zdotdir"',
    '  unset __vesperwind_zdotdir',
    'fi',
  ]

  if (!['.zshrc', '.zlogin'].includes(filename)) {
    return `${sourceUserConfiguration.join('\n')}\n`
  }

  return `${sourceUserConfiguration.join('\n')}

if [[ "$PROMPT" == ${quoteZshValue(DEFAULT_ZSH_PROMPT)} ]]; then
  PROMPT=${quoteZshValue(VESPERWIND_ZSH_PROMPT)}
fi
`
}

const createZshStartupDirectory = async () => {
  const originalDirectory = process.env.ZDOTDIR || process.env.HOME || os.homedir()
  const startupDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'vesperwind-zsh-'),
  )

  await Promise.all(
    ZSH_STARTUP_FILES.map((filename) =>
      fs.writeFile(
        path.join(startupDirectory, filename),
        buildZshStartupFile(originalDirectory, filename),
        { mode: 0o600 },
      ),
    ),
  )

  zshStartupDirectory = startupDirectory
  return startupDirectory
}

const getZshStartupDirectory = () => {
  zshStartupDirectoryPromise ||= createZshStartupDirectory()
  return zshStartupDirectoryPromise
}

const createTerminalEnvironment = async (shell) => {
  const environment = {
    ...sanitizeTerminalEnvironment(process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR: process.env.CLICOLOR || '1',
    LSCOLORS: process.env.LSCOLORS || DEFAULT_LS_COLORS,
  }

  if (path.basename(shell) === 'zsh') {
    environment.ZDOTDIR = await getZshStartupDirectory()
  }

  return environment
}

process.once('exit', () => {
  if (zshStartupDirectory) {
    fsSync.rmSync(zshStartupDirectory, { recursive: true, force: true })
  }
})

export const registerTerminalHandlers = (socket, { cwd, ssh }) => {
  const sessions = new Map()

  const closeSession = (id) => {
    const session = sessions.get(id)
    if (!session) return
    try {
      session.process.kill()
    } catch {
      // The PTY may already have exited.
    }

    sessions.delete(id)
  }

  socket.on('terminal:create', async (payload, acknowledge) => {
    if (payload?.type === 'ssh') {
      try {
        const remote = await ssh.createTerminal({
          connectionId: payload.connectionId,
          cols: clampInteger(payload?.cols, MIN_COLUMNS, MAX_COLUMNS, 80),
          rows: clampInteger(payload?.rows, MIN_ROWS, MAX_ROWS, 24),
        })
        acknowledge?.({ ok: true, ...remote, reused: false })
      } catch (error) {
        acknowledge?.({ ok: false, error: serializeTerminalError(error) })
      }
      return
    }

    const shell = process.env.SHELL || '/bin/zsh'
    const columns = clampInteger(payload?.cols, MIN_COLUMNS, MAX_COLUMNS, 80)
    const rows = clampInteger(payload?.rows, MIN_ROWS, MAX_ROWS, 24)

    try {
      const environment = await createTerminalEnvironment(shell)
      const terminalProcess = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: columns,
        rows,
        cwd,
        env: environment,
      })

      const id = randomUUID()
      sessions.set(id, { id, process: terminalProcess })

      terminalProcess.onData((data) => {
        socket.emit('terminal:output', { id, data })
      })

      terminalProcess.onExit(({ exitCode, signal }) => {
        socket.emit('terminal:exit', { id, exitCode, signal })

        sessions.delete(id)
      })

      acknowledge?.({ ok: true, id, reused: false })
    } catch (error) {
      acknowledge?.({ ok: false, error: serializeTerminalError(error) })
    }
  })

  socket.on('terminal:input', (payload) => {
    if (typeof payload?.data !== 'string') return
    const session = sessions.get(payload?.id)
    if (session) session.process.write(payload.data)
    else ssh.writeTerminal(payload?.id, payload.data)
  })

  socket.on('terminal:resize', (payload) => {
    const columns = clampInteger(payload?.cols, MIN_COLUMNS, MAX_COLUMNS, 80)
    const rows = clampInteger(payload?.rows, MIN_ROWS, MAX_ROWS, 24)
    const session = sessions.get(payload?.id)
    if (!session) {
      ssh.resizeTerminal(payload?.id, columns, rows)
      return
    }

    try {
      session.process.resize(columns, rows)
    } catch {
      // A resize can race with a shell process exiting.
    }
  })

  socket.on('terminal:close', (payload, acknowledge) => {
    if (payload?.id) {
      closeSession(payload.id)
      ssh.closeTerminal(payload.id)
    } else for (const id of sessions.keys()) closeSession(id)

    acknowledge?.({ ok: true })
  })

  socket.on('disconnect', () => {
    for (const id of sessions.keys()) closeSession(id)
  })
}
