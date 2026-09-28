import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createDirectoryWatchRegistry } from '../src/api/directoryWatch.js'
import { reconcileDirectorySelection } from '../src/utils/reconcileDirectorySelection.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-watch-'))
process.env.FILE_MANAGER_ROOT = root
const { createLocalWatchRegistry } = await import('../server/directoryWatch.js')
const { performFileOperation } = await import('../server/fileOperations.js')
const { listDirectory } = await import('../server/filesystem.js')
test.after(async () => fs.rm(root, { recursive: true, force: true }))

const waitFor = async (predicate, timeout = 2500) => {
  const until = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Timed out waiting for filesystem event')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('native Node watcher sees create, rename, move, modify, and delete in scoped directories', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'Unicode space 目录 '))
  const outside = await fs.mkdtemp(path.join(root, 'outside-'))
  const registry = createLocalWatchRegistry()
  const socket = { emit: (_name, event) => events.push(event) }
  const events = []
  await registry.subscribe(socket, directory)
  assert.equal(registry.size(), 1)
  const expectChange = async (operation) => {
    events.length = 0
    await operation()
    await waitFor(() => events.length > 0)
    assert.equal(events.at(-1).directoryPath, directory)
    assert.equal(events.at(-1).providerId, 'local')
    assert.equal(events.at(-1).kind, 'changed')
  }
  const first = path.join(directory, 'café file.txt')
  const renamed = path.join(directory, 'renamed.txt')
  await expectChange(() => fs.writeFile(first, 'first'))
  await expectChange(() => fs.mkdir(path.join(directory, 'folder')))
  await expectChange(() => fs.rename(first, renamed))
  await expectChange(() => fs.writeFile(renamed, 'changed'))
  await fs.writeFile(path.join(outside, 'incoming.txt'), 'incoming')
  await expectChange(() => fs.rename(path.join(outside, 'incoming.txt'), path.join(directory, 'incoming.txt')))
  await expectChange(() => fs.rename(path.join(directory, 'incoming.txt'), path.join(outside, 'outgoing.txt')))
  await expectChange(() => fs.unlink(renamed))
  await expectChange(() => fs.rmdir(path.join(directory, 'folder')))
  registry.unsubscribe(socket, directory)
  assert.equal(registry.size(), 0)
})

test('two consumers share one underlying Node watcher; last unsubscribe closes it', async () => {
  let created = 0
  let closed = 0
  const registry = createLocalWatchRegistry({ watch: () => {
    created += 1
    return Object.assign(new EventEmitter(), { close: () => { closed += 1 } })
  } })
  const one = { emit() {} }
  const two = { emit() {} }
  await registry.subscribe(one, root)
  await registry.subscribe(two, root)
  assert.equal(created, 1)
  registry.unsubscribe(one, root)
  assert.equal(closed, 0)
  registry.unsubscribe(two, root)
  assert.equal(closed, 1)
  for (let cycle = 0; cycle < 25; cycle++) {
    await registry.subscribe(one, root)
    registry.unsubscribe(one, root)
  }
  assert.equal(registry.size(), 0)
  assert.equal(created, closed)
})

test('watch paths obey FILE_MANAGER_ROOT and symlink restrictions', async () => {
  const registry = createLocalWatchRegistry()
  const consumer = { emit() {} }
  await assert.rejects(registry.subscribe(consumer, os.tmpdir()), { code: 'EOUTSIDE_ROOT' })
  const link = path.join(root, 'outside-link')
  await fs.symlink(os.tmpdir(), link)
  await assert.rejects(registry.subscribe(consumer, link), { code: 'EOUTSIDE_ROOT' })
  assert.equal(registry.size(), 0)
})

test('frontend registry coalesces bursts and releases subscriptions on collapse or swap', async () => {
  const requests = []
  const listeners = new Map()
  const transport = {
    request: async (name, payload) => { requests.push([name, payload]); return { ok: true } },
    subscribe: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name) },
    subscribeToConnection: () => () => {},
  }
  const registry = createDirectoryWatchRegistry(transport, 30)
  let left = 0
  let right = 0
  const stopLeft = registry.subscribe('local', '/project/目录', () => { left += 1 })
  const stopRight = registry.subscribe('local', '/project/目录', () => { right += 1 })
  assert.equal(registry.count(), 1)
  await waitFor(() => requests.length === 1)
  assert.equal(requests.filter(([name]) => name === 'filesystem:watch').length, 1)
  for (let index = 0; index < 5; index++) {
    listeners.get('filesystem:changed')({ providerId: 'local', directoryPath: '/project/目录', kind: 'changed' })
  }
  await waitFor(() => left === 1 && right === 1)
  stopLeft() // one panel collapses or moves elsewhere
  assert.equal(registry.count(), 1)
  stopRight() // last view closes
  assert.equal(registry.count(), 0)
  await waitFor(() => requests.length === 2)
  assert.equal(requests.filter(([name]) => name === 'filesystem:unwatch').length, 1)
  assert.equal(listeners.size, 0)
  const stopRemote = registry.subscribe('sftp:example', '/project/目录', () => {})
  assert.equal(registry.count(), 0)
  stopRemote()
})

test('rapid navigation serializes watch and unwatch without leaking subscriptions', async () => {
  const calls = []
  let releaseFirst
  const first = new Promise((resolve) => { releaseFirst = resolve })
  const transport = {
    request: async (name) => {
      calls.push(name)
      if (calls.length === 1) await first
      return { ok: true }
    },
    subscribe: () => () => {},
    subscribeToConnection: () => () => {},
  }
  const registry = createDirectoryWatchRegistry(transport, 10)
  const stop = registry.subscribe('local', '/project', () => {})
  await waitFor(() => calls.length === 1)
  stop()
  const stopAgain = registry.subscribe('local', '/project', () => {})
  assert.deepEqual(calls, ['filesystem:watch'])
  releaseFirst()
  await waitFor(() => calls.length === 3)
  assert.deepEqual(calls, ['filesystem:watch', 'filesystem:unwatch', 'filesystem:watch'])
  stopAgain()
  await waitFor(() => calls.length === 4)
  assert.equal(registry.count(), 0)
})

test('own create, copy, move, and delete converge with watcher refreshes', async () => {
  const source = await fs.mkdtemp(path.join(root, 'own-source-'))
  const target = await fs.mkdtemp(path.join(root, 'own-target-'))
  const backendRegistry = createLocalWatchRegistry()
  const listeners = new Map()
  const events = []
  const socket = { emit: (name, payload) => listeners.get(name)?.(payload) }
  const transport = {
    request: async (name, payload) => {
      if (name === 'filesystem:watch') return backendRegistry.subscribe(socket, payload.path)
      backendRegistry.unsubscribe(socket, payload.path)
      return { ok: true }
    },
    subscribe: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name) },
    subscribeToConnection: () => () => {},
  }
  const frontendRegistry = createDirectoryWatchRegistry(transport, 50)
  const onChange = (event) => { events.push(event.directoryPath) }
  const stopSource = frontendRegistry.subscribe('local', source, onChange)
  const stopTarget = frontendRegistry.subscribe('local', target, onChange)
  await waitFor(() => backendRegistry.size() === 2)
  const waitForDirectory = async (directory, operation) => {
    const previousCount = events.filter((entry) => entry === directory).length
    await operation()
    await waitFor(() => events.filter((entry) => entry === directory).length > previousCount)
    const names = (await listDirectory(directory)).map((entry) => entry.name)
    assert.equal(new Set(names).size, names.length)
    return names
  }
  const created = await waitForDirectory(source, () => performFileOperation({ action: 'create-file', targetDirectory: source, name: 'own.txt' }))
  assert.deepEqual(created, ['own.txt'])
  const copied = await waitForDirectory(target, () => performFileOperation({ action: 'copy', sourcePath: path.join(source, 'own.txt'), targetDirectory: target }))
  assert.deepEqual(copied, ['own.txt'])
  await waitForDirectory(source, () => performFileOperation({ action: 'delete', sourcePath: path.join(source, 'own.txt') }))
  const moved = await waitForDirectory(source, () => performFileOperation({ action: 'move', sourcePath: path.join(target, 'own.txt'), targetDirectory: source }))
  assert.deepEqual(moved, ['own.txt'])
  const deleted = await waitForDirectory(source, () => performFileOperation({ action: 'delete', sourcePath: path.join(source, 'own.txt') }))
  assert.deepEqual(deleted, [])
  stopSource()
  stopTarget()
  await waitFor(() => backendRegistry.size() === 0)
})

test('directory refresh preserves unrelated selection and drops only removed entries', () => {
  const alpha = { path: '/project/alpha', name: 'alpha' }
  const beta = { path: '/project/beta', name: 'beta' }
  const state = { selectedEntries: [alpha, beta], selectedNode: beta,
    anchorPath: alpha.path, rootPath: '/project', root: { path: '/project' } }
  const created = { path: '/project/new', name: 'new' }
  const unchanged = reconcileDirectorySelection(state, '/project', [alpha, beta, created], 'local')
  assert.deepEqual(unchanged.selectedEntries.map((entry) => entry.path), [alpha.path, beta.path])
  assert.equal(unchanged.anchorPath, alpha.path)
  const repeated = reconcileDirectorySelection({ ...state, ...unchanged }, '/project', [alpha, beta, created], 'local')
  assert.deepEqual(repeated.selectedEntries.map((entry) => entry.path), [alpha.path, beta.path])
  assert.equal(repeated.anchorPath, alpha.path)
  const deleted = reconcileDirectorySelection(state, '/project', [beta, created], 'local')
  assert.deepEqual(deleted.selectedEntries.map((entry) => entry.path), [beta.path])
  assert.equal(deleted.anchorPath, beta.path)
  assert.equal(deleted.selectedPath, beta.path)
})
