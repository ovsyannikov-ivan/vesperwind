// Shared helpers for `npm run build:libmpv`. Platform builders throw
// BuildError for conditions the user has to resolve; the entry point prints
// only its message.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

export class BuildError extends Error {}

export const log = (message) => console.log(`[build:libmpv] ${message}`)

export const exists = (file) => {
  try { fs.accessSync(file); return true } catch { return false }
}

// Runs a command with inherited output; resolves on exit code 0.
export const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  child.once('error', (error) => reject(new BuildError(`${path.basename(command)} could not start: ${error.message}`)))
  child.once('exit', (code, signal) => code === 0
    ? resolve()
    : reject(new BuildError(options.failure || `${path.basename(command)} failed (${signal || `exit ${code}`})`)))
})

export const findOnPath = (name, extraDirectories = []) => {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const directories = [...(process.env.PATH || '').split(path.delimiter), ...extraDirectories]
  for (const directory of directories.filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

// The bundle verifier compiles a small Rust probe for the network protocols.
export const rustEnvironment = () => {
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin')
  if (!findOnPath('rustc', [cargoBin])) {
    throw new BuildError('Rust is required to verify the bundle (it also builds Vesperwind). Install it from https://rustup.rs and rerun:\n\n  npm run build:libmpv')
  }
  // Windows spells the variable Path; extend the existing key, never add a second.
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') || 'PATH'
  return { ...process.env, [key]: [process.env[key], cargoBin].filter(Boolean).join(path.delimiter) }
}

const freeGigabytes = (directory) => {
  try {
    const stats = fs.statfsSync(directory)
    return (stats.bavail * stats.bsize) / 1024 ** 3
  } catch { return Infinity }
}

export const requireFreeSpace = (directory, gigabytes) => {
  const free = freeGigabytes(directory)
  if (free < gigabytes) {
    throw new BuildError(`The libmpv build needs about ${gigabytes} GB free in ${directory}; ${free.toFixed(1)} GB is available. Free some space and rerun npm run build:libmpv.`)
  }
}

export const jobs = () => String(Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)))
