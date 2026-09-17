import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  CliArgumentError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  formatHelp,
  formatSecurityWarning,
  formatVersion,
  isLoopbackHost,
  resolveRuntimeConfig,
} from '../server/cli.js'

const testCwd = path.resolve(path.sep, 'workspace')
const testHomeDirectory = path.resolve(path.sep, 'Users', 'default')
const testRoot = path.resolve(path.sep, 'Users', 'ivan')

const testContext = {
  cwd: testCwd,
  homeDirectory: testHomeDirectory,
}

test('accepts short and long standalone options', () => {
  const shortOptions = resolveRuntimeConfig({
    ...testContext,
    argv: ['-r', testRoot, '-p', '3101', '--host', '0.0.0.0'],
    env: {},
  })
  const longOptions = resolveRuntimeConfig({
    ...testContext,
    argv: ['--root', testRoot, '--port', '3101'],
    env: {},
  })

  assert.deepEqual(shortOptions, {
    command: null,
    root: testRoot,
    port: 3101,
    host: '0.0.0.0',
  })
  assert.deepEqual(longOptions, {
    command: null,
    root: testRoot,
    port: 3101,
    host: DEFAULT_HOST,
  })
})

test('uses CLI arguments before environment variables before defaults', () => {
  const environmentOptions = resolveRuntimeConfig({
    ...testContext,
    argv: [],
    env: {
      FILE_MANAGER_ROOT: 'environment-root',
      PORT: '3201',
      HOST: 'localhost',
    },
  })
  const cliOptions = resolveRuntimeConfig({
    ...testContext,
    argv: ['--root=cli-root', '--port=3301', '--host=127.0.0.2'],
    env: {
      FILE_MANAGER_ROOT: 'environment-root',
      PORT: '3201',
      HOST: 'localhost',
    },
  })
  const defaultOptions = resolveRuntimeConfig({
    ...testContext,
    argv: [],
    env: {},
  })

  assert.deepEqual(environmentOptions, {
    command: null,
    root: path.resolve(testCwd, 'environment-root'),
    port: 3201,
    host: 'localhost',
  })
  assert.deepEqual(cliOptions, {
    command: null,
    root: path.resolve(testCwd, 'cli-root'),
    port: 3301,
    host: '127.0.0.2',
  })
  assert.deepEqual(defaultOptions, {
    command: null,
    root: testHomeDirectory,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
  })
})

test('provides standalone help and version output', () => {
  assert.equal(
    resolveRuntimeConfig({ ...testContext, argv: ['--help'], env: {} }).command,
    'help',
  )
  assert.equal(
    resolveRuntimeConfig({ ...testContext, argv: ['-v'], env: {} }).command,
    'version',
  )
  assert.match(formatHelp(), /-r, --root <path>/)
  assert.match(formatHelp(), /-p, --port <number>/)
  assert.match(formatHelp(), /--host <address>/)
  assert.match(formatHelp(), /Security:/)
  assert.match(formatHelp(), /does not provide built-in authentication/)
  assert.match(formatHelp(), /ssh -L 3101:127\.0\.0\.1:3101 user@server/)
  assert.match(formatHelp(), /does not require --host 0\.0\.0\.0/)
  assert.equal(formatVersion(), 'Vesperwind 0.1.0')
})

test('identifies only the supported loopback host names', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('LOCALHOST'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
  assert.equal(isLoopbackHost('192.168.1.10'), false)
  assert.equal(isLoopbackHost('127.0.0.2'), false)
})

test('formats a prominent warning for non-loopback hosts', () => {
  const warning = formatSecurityWarning({ host: '0.0.0.0', port: 3101 })

  assert.match(
    warning,
    /WARNING: Vesperwind has no built-in authentication and is listening on a non-loopback interface\./,
  )
  assert.match(warning, /0\.0\.0\.0:3101/)
  assert.match(warning, /SSH tunnel/)
  assert.match(warning, /bound to 127\.0\.0\.1/)
})

test('rejects invalid and incomplete CLI options', () => {
  assert.throws(
    () => resolveRuntimeConfig({ ...testContext, argv: ['--port', 'abc'], env: {} }),
    CliArgumentError,
  )
  assert.throws(
    () => resolveRuntimeConfig({ ...testContext, argv: ['--port', '70000'], env: {} }),
    CliArgumentError,
  )
  assert.throws(
    () => resolveRuntimeConfig({ ...testContext, argv: ['--root'], env: {} }),
    CliArgumentError,
  )
  assert.throws(
    () => resolveRuntimeConfig({ ...testContext, argv: ['--unknown'], env: {} }),
    CliArgumentError,
  )
})
