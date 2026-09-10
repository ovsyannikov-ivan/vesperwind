import process from 'node:process'
import { io } from 'socket.io-client'

const socket = io('http://127.0.0.1:3001', {
  transports: ['websocket'],
  timeout: 5_000,
})

const emitWithAck = (eventName, payload = {}) =>
  socket.timeout(10_000).emitWithAck(eventName, payload)

const waitForConnection = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 8_000)

    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })

    socket.once('connect_error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

const waitForTerminalMarker = (terminalId) =>
  new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      socket.off('terminal:output', onOutput)
      reject(new Error(`Terminal output timed out. Received: ${JSON.stringify(output)}`))
    }, 10_000)

    const onOutput = (payload) => {
      if (payload?.id !== terminalId) {
        return
      }

      output += payload.data

      if (output.includes('__PELORUS_PTY_OK__')) {
        clearTimeout(timer)
        socket.off('terminal:output', onOutput)
        resolve(output)
      }
    }

    socket.on('terminal:output', onOutput)
    socket.emit('terminal:input', {
      id: terminalId,
      data: "printf '__PELORUS_PTY_OK__\\n'; pwd\n",
    })
  })

try {
  if (!socket.connected) {
    await waitForConnection()
  }

  const rootResponse = await emitWithAck('filesystem:root')

  if (!rootResponse?.ok) {
    throw new Error(`Filesystem root failed: ${rootResponse?.error?.message}`)
  }

  const listResponse = await emitWithAck('filesystem:list', {
    path: rootResponse.root.path,
  })

  if (!listResponse?.ok || !Array.isArray(listResponse.entries)) {
    throw new Error(`Filesystem list failed: ${listResponse?.error?.message}`)
  }

  const firstFileIndex = listResponse.entries.findIndex((entry) => !entry.isDirectory)
  const folderAfterFile = listResponse.entries
    .slice(Math.max(0, firstFileIndex))
    .some((entry) => entry.isDirectory)

  if (firstFileIndex >= 0 && folderAfterFile) {
    throw new Error('Filesystem entries are not sorted with folders first')
  }

  const terminalResponse = await emitWithAck('terminal:create', { cols: 80, rows: 24 })

  if (!terminalResponse?.ok) {
    throw new Error(`Terminal create failed: ${terminalResponse?.error?.message}`)
  }

  const terminalOutput = await waitForTerminalMarker(terminalResponse.id)

  console.log(
    JSON.stringify(
      {
        socket: 'connected',
        root: rootResponse.root.path,
        entries: listResponse.entries.length,
        terminal: terminalOutput.includes('__PELORUS_PTY_OK__') ? 'interactive' : 'failed',
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  socket.disconnect()
}
