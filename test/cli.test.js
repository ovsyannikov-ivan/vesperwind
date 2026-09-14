import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  CliArgumentError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  formatHelp,
  formatVersion,
  resolveRuntimeConfig,
} from '../server/cli.js'

const testContext = {
  cwd: '/workspace',
  homeDirectory: '/Users/default',
}

test('accepts short and long standalone options', () => {
  const shortOptions = resolveRuntimeConfig({
    ...testContext,
    argv: ['-r', '/Users/ivan', '-p', '3101', '--host', '0.0.0.0'],
    env: {},
  })
  const longOptions = resolveRuntimeConfig({
    ...testContext,
    argv: ['--root', '/Users/ivan', '--port', '3101'],
    env: {},
  })

  assert.deepEqual(shortOptions, {
    command: null,
    root: '/Users/ivan',
    port: 3101,
    host: '0.0.0.0',
  })
  assert.deepEqual(longOptions, {
    command: null,
    root: '/Users/ivan',
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
    root: path.resolve('/workspace', 'environment-root'),
    port: 3201,
    host: 'localhost',
  })
  assert.deepEqual(cliOptions, {
    command: null,
    root: path.resolve('/workspace', 'cli-root'),
    port: 3301,
    host: '127.0.0.2',
  })
  assert.deepEqual(defaultOptions, {
    command: null,
    root: '/Users/default',
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
  assert.equal(formatVersion(), 'Vesperwind 0.1.0')
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
