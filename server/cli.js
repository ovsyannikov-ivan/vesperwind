import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { APP_NAME, APP_VERSION } from '../shared/appMetadata.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3001

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export class CliArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliArgumentError'
    this.code = 'ECLI_ARGUMENT'
  }
}

const requireValue = (argv, index, optionName) => {
  const value = argv[index + 1]

  if (value === undefined) {
    throw new CliArgumentError(`${optionName} requires a value`)
  }

  return value
}

const requireNonEmpty = (value, optionName) => {
  const normalized = typeof value === 'string' ? value.trim() : ''

  if (!normalized) {
    throw new CliArgumentError(`${optionName} requires a non-empty value`)
  }

  return normalized
}

const parsePort = (value, optionName) => {
  const normalized = requireNonEmpty(value, optionName)

  if (!/^\d+$/.test(normalized)) {
    throw new CliArgumentError(`${optionName} must be an integer from 1 to 65535`)
  }

  const port = Number(normalized)

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new CliArgumentError(`${optionName} must be an integer from 1 to 65535`)
  }

  return port
}

export const parseCliArguments = (argv = []) => {
  const parsed = {
    root: undefined,
    port: undefined,
    host: undefined,
    command: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '-h' || argument === '--help') {
      parsed.command = 'help'
      continue
    }

    if (argument === '-v' || argument === '--version') {
      parsed.command = 'version'
      continue
    }

    if (argument === '-r' || argument === '--root') {
      parsed.root = requireValue(argv, index, argument)
      index += 1
      continue
    }

    if (argument.startsWith('--root=')) {
      parsed.root = argument.slice('--root='.length)
      continue
    }

    if (argument === '-p' || argument === '--port') {
      parsed.port = requireValue(argv, index, argument)
      index += 1
      continue
    }

    if (argument.startsWith('--port=')) {
      parsed.port = argument.slice('--port='.length)
      continue
    }

    if (argument === '--host') {
      parsed.host = requireValue(argv, index, argument)
      index += 1
      continue
    }

    if (argument.startsWith('--host=')) {
      parsed.host = argument.slice('--host='.length)
      continue
    }

    throw new CliArgumentError(`Unknown option: ${argument}`)
  }

  return parsed
}

export const resolveRuntimeConfig = ({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  homeDirectory = os.homedir(),
} = {}) => {
  const parsed = parseCliArguments(argv)

  if (parsed.command) {
    return { ...parsed, root: null, port: null, host: null }
  }

  const environmentRoot = env.FILE_MANAGER_ROOT?.trim() || undefined
  const environmentPort = env.PORT?.trim() || undefined
  const environmentHost = env.HOST?.trim() || undefined
  const rootValue = requireNonEmpty(
    parsed.root ?? environmentRoot ?? homeDirectory,
    parsed.root !== undefined ? '--root' : 'FILE_MANAGER_ROOT',
  )
  const host = requireNonEmpty(
    parsed.host ?? environmentHost ?? DEFAULT_HOST,
    parsed.host !== undefined ? '--host' : 'HOST',
  )
  const port = parsePort(
    parsed.port ?? environmentPort ?? String(DEFAULT_PORT),
    parsed.port !== undefined ? '--port' : 'PORT',
  )

  return {
    command: null,
    root: path.resolve(cwd, rootValue),
    port,
    host,
  }
}

export const isLoopbackHost = (host) =>
  LOOPBACK_HOSTS.has(typeof host === 'string' ? host.trim().toLowerCase() : '')

export const formatHelp = () => `${APP_NAME} ${APP_VERSION}

Usage: vesperwind [options]

Options:
  -r, --root <path>      File manager root directory
  -p, --port <number>    HTTP port (default: ${DEFAULT_PORT})
      --host <address>   Bind address (default: ${DEFAULT_HOST})
  -h, --help             Show this help
  -v, --version          Show the ${APP_NAME} version

Environment fallback:
  FILE_MANAGER_ROOT, PORT, HOST

Priority: CLI arguments > environment variables > defaults

Security:
  Vesperwind does not provide built-in authentication.

  By default, the server listens on ${DEFAULT_HOST} and is accessible only
  from the local machine. This is the recommended mode.

  Do not expose Vesperwind directly to the Internet or an untrusted LAN with
  --host 0.0.0.0.

  For remote access, prefer an SSH tunnel:
    ssh -L 3101:127.0.0.1:3101 user@server

  Then open:
    http://127.0.0.1:3101

  Keep Vesperwind bound to 127.0.0.1 on the remote machine. An SSH tunnel
  does not require --host 0.0.0.0.`

export const formatSecurityWarning = ({ host, port }) =>
  `WARNING: Vesperwind has no built-in authentication and is listening on a non-loopback interface.

The server is listening on ${host}:${port} and may be accessible from other hosts.

Do not expose Vesperwind directly to the Internet or an untrusted LAN.

For remote access, prefer an SSH tunnel while keeping Vesperwind bound to 127.0.0.1.`

export const formatVersion = () => `${APP_NAME} ${APP_VERSION}`
