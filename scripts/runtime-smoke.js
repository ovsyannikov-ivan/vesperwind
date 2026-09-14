import process from 'node:process'
import path from 'node:path'
import { io } from 'socket.io-client'

const backendUrl = process.env.VESPERWIND_BACKEND_URL || 'http://127.0.0.1:3001'
const socket = io(backendUrl, {
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

      if (output.includes('__VESPERWIND_PTY_OK__')) {
        clearTimeout(timer)
        socket.off('terminal:output', onOutput)
        resolve(output)
      }
    }

    socket.on('terminal:output', onOutput)
    socket.emit('terminal:input', {
      id: terminalId,
      data: "printf '__VESPERWIND_PTY_OK__\\n'; pwd\n",
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

  const settingsResponse = await emitWithAck('settings:get')

  if (
    !settingsResponse?.ok ||
    !Array.isArray(settingsResponse.settings?.filesystem?.hiddenNameSuffixes) ||
    !Array.isArray(settingsResponse.settings?.editor?.editableFiles) ||
    !['', 'ru-RU', 'en-GB'].includes(settingsResponse.settings?.appearance?.locale) ||
    !['system', 'dark', 'light'].includes(settingsResponse.settings?.appearance?.theme)
  ) {
    throw new Error(`Settings failed: ${settingsResponse?.error?.message}`)
  }

  const editorReadResponse = await emitWithAck('filesystem:read-text', {
    filesystemId: 'local',
    path: path.join(process.cwd(), 'package.json'),
  })

  if (!editorReadResponse?.ok || !editorReadResponse.content.includes('vesperwind-file-manager')) {
    throw new Error(`Editor text read failed: ${editorReadResponse?.error?.message}`)
  }

  const operationResponse = await emitWithAck('filesystem:operate', {
    action: 'invalid-smoke-action',
    sourcePath: rootResponse.root.path,
    targetDirectory: rootResponse.root.path,
  })

  if (operationResponse?.ok || operationResponse?.error?.code !== 'EINVAL') {
    throw new Error('Filesystem operation handler did not return a safe validation error')
  }

  const deleteGuardResponse = await emitWithAck('filesystem:operate', {
    action: 'delete',
    sourcePath: rootResponse.root.path,
  })

  if (deleteGuardResponse?.ok || deleteGuardResponse?.error?.code !== 'EROOT_OPERATION') {
    throw new Error('Filesystem root deletion guard is not active')
  }

  const mediaGuardResponse = await fetch(
    `${backendUrl}/api/media?path=${encodeURIComponent(rootResponse.root.path)}`,
  )
  const mediaGuardBody = await mediaGuardResponse.json()

  if (
    mediaGuardResponse.status !== 400 ||
    mediaGuardBody?.error?.code !== 'ENOTFILE'
  ) {
    throw new Error('Media endpoint did not reject a directory path')
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
        fileOperations: 'registered and root-protected',
        mediaStreaming: 'registered and path-validated',
        settings: settingsResponse.storagePath,
        editorFilesystem: 'readable through Socket.io adapter',
        terminal: terminalOutput.includes('__VESPERWIND_PTY_OK__') ? 'interactive' : 'failed',
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
