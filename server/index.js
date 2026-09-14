import http from 'node:http'
import { Server } from 'socket.io'
import {
  CliArgumentError,
  formatHelp,
  formatSecurityWarning,
  formatVersion,
  isLoopbackHost,
  resolveRuntimeConfig,
} from './cli.js'

const startServer = async () => {
  const runtimeConfig = resolveRuntimeConfig()

  if (runtimeConfig.command === 'help') {
    console.log(formatHelp())
    return
  }

  if (runtimeConfig.command === 'version') {
    console.log(formatVersion())
    return
  }

  // Filesystem modules resolve their guarded root at module initialization.
  // Apply the fully resolved CLI/environment configuration before loading them.
  process.env.FILE_MANAGER_ROOT = runtimeConfig.root

  const [
    { fileManagerRoot, registerFilesystemHandlers },
    { registerFileOperationHandlers },
    { serveMedia },
    { registerTerminalHandlers },
    { registerSettingsHandlers },
    { serveStaticAsset },
    { registerTextFileHandlers },
  ] = await Promise.all([
    import('./filesystem.js'),
    import('./fileOperations.js'),
    import('./media.js'),
    import('./terminal.js'),
    import('./settings.js'),
    import('./staticAssets.js'),
    import('./textFiles.js'),
  ])

  const handleRequest = async (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, root: fileManagerRoot }))
      return
    }

    if (await serveMedia(request, response)) {
      return
    }

    if (await serveStaticAsset(request, response)) {
      return
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, error: 'Not found' }))
  }

  const requestHandler = (request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(`Request failed: ${error.message}`)

      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      }

      response.end('Internal server error')
    })
  }

  const httpServer = http.createServer(requestHandler)
  const io = new Server(httpServer, {
    maxHttpBufferSize: 12 * 1024 * 1024,
  })

  io.on('connection', (socket) => {
    registerFilesystemHandlers(socket)
    registerFileOperationHandlers(socket)
    registerSettingsHandlers(socket)
    registerTextFileHandlers(socket)
    registerTerminalHandlers(socket, { cwd: fileManagerRoot })
  })

  httpServer.on('error', (error) => {
    console.error(`Backend failed: ${error.message}`)
    process.exit(1)
  })

  httpServer.listen(runtimeConfig.port, runtimeConfig.host, () => {
    console.log(
      `Vesperwind backend listening on http://${runtimeConfig.host}:${runtimeConfig.port}`,
    )
    console.log(`Filesystem root: ${fileManagerRoot}`)

    if (!isLoopbackHost(runtimeConfig.host)) {
      console.warn(`\n${formatSecurityWarning(runtimeConfig)}\n`)
    }
  })

  const shutdown = () => {
    io.close(() => {
      httpServer.close(() => process.exit(0))
    })

    setTimeout(() => process.exit(1), 3_000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

startServer().catch((error) => {
  console.error(`Vesperwind failed to start: ${error.message}`)

  if (error instanceof CliArgumentError) {
    console.error('Run vesperwind --help for usage.')
  }

  process.exitCode = 1
})
