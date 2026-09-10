import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const children = new Map()
let shuttingDown = false
let finalExitCode = 0
let forceExitTimer = null

const stopChild = (child, signal = 'SIGTERM') => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  try {
    child.kill(signal)
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error(error)
    }
  }
}

const finishIfStopped = () => {
  if (shuttingDown && children.size === 0) {
    clearTimeout(forceExitTimer)
    process.exit(finalExitCode)
  }
}

const shutdown = (exitCode = 0) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  finalExitCode = exitCode

  for (const child of children.keys()) {
    stopChild(child)
  }

  forceExitTimer = setTimeout(() => {
    for (const child of children.keys()) {
      stopChild(child, 'SIGKILL')
    }

    process.exit(finalExitCode)
  }, 3_000)
  forceExitTimer.unref()
  finishIfStopped()
}

const startProcess = (name, args) => {
  console.log(`[${name}] starting`)

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
    stdio: 'inherit',
  })

  children.set(child, name)

  child.once('error', (error) => {
    console.error(`[${name}] failed to start: ${error.message}`)
    children.delete(child)
    shutdown(1)
  })

  child.once('exit', (code, signal) => {
    children.delete(child)

    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `code ${code}`
      console.error(`[${name}] exited unexpectedly with ${reason}`)
      shutdown(code || 1)
      return
    }

    finishIfStopped()
  })
}

process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))

const assertPortAvailable = (port, host = '127.0.0.1') =>
  new Promise((resolve, reject) => {
    const tester = net.createServer()

    tester.unref()
    tester.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use on ${host}`))
        return
      }

      reject(error)
    })
    tester.listen(port, host, () => tester.close(resolve))
  })

try {
  await Promise.all([assertPortAvailable(3001), assertPortAvailable(5173)])
  startProcess('backend', ['server/index.js'])
  startProcess('frontend', [viteCli, '--host', '127.0.0.1'])
} catch (error) {
  console.error(`[dev] ${error.message}`)
  process.exitCode = 1
}
