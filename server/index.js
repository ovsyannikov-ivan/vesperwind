import http from 'node:http'
import { Server } from 'socket.io'
import {
  fileManagerRoot,
  registerFilesystemHandlers,
} from './filesystem.js'
import { registerTerminalHandlers } from './terminal.js'

const host = process.env.HOST || '127.0.0.1'
const port = Number.parseInt(process.env.PORT || '3001', 10)

const requestHandler = (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, root: fileManagerRoot }))
    return
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ ok: false, error: 'Not found' }))
}

const httpServer = http.createServer(requestHandler)
const io = new Server(httpServer, {
  maxHttpBufferSize: 1e6,
})

io.on('connection', (socket) => {
  registerFilesystemHandlers(socket)
  registerTerminalHandlers(socket, { cwd: fileManagerRoot })
})

httpServer.on('error', (error) => {
  console.error(`Backend failed: ${error.message}`)
  process.exit(1)
})

httpServer.listen(port, host, () => {
  console.log(`Pelorus backend listening on http://${host}:${port}`)
  console.log(`Filesystem root: ${fileManagerRoot}`)
})

const shutdown = () => {
  io.close(() => {
    httpServer.close(() => process.exit(0))
  })

  setTimeout(() => process.exit(1), 3_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
