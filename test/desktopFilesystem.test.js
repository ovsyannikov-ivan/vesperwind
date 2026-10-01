import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFilesystemAccess, listWindowsDrives } from '../server/filesystemAccess.js'
import { COMPUTER_PATH, localNavigation } from '../shared/localFilesystem.js'
import { buildPathBreadcrumbs } from '../src/utils/pathBreadcrumbs.js'
import { isSameOrDescendantPath } from '../src/utils/filesystemPath.js'
import { restorePanelViewState } from '../src/utils/panelSwap.js'
import { createDirectoryWatchRegistry } from '../src/api/directoryWatch.js'

test('desktop starting folders are independent of browser confinement', () => {
  const config = { desktop: true, home: '/Users/example', browserRoot: '/confined' }
  assert.deepEqual(localNavigation({ ...config, platform: 'darwin' }), { root: '/', initial: '/Users/example' })
  assert.deepEqual(localNavigation({ ...config, platform: 'linux' }), { root: '/', initial: '/' })
  assert.deepEqual(localNavigation({ ...config, platform: 'win32' }), { root: COMPUTER_PATH, initial: COMPUTER_PATH })
  assert.deepEqual(localNavigation({ ...config, platform: 'linux', desktop: false }), { root: '/confined', initial: '/confined' })
})

test('desktop resolves and reads outside the starting folder; browser rejects both lexical and symlink escapes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-access-'))
  try {
    const home = path.join(fixture, 'home')
    const outside = path.join(fixture, 'outside')
    await fs.mkdir(home)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'movie.txt'), 'accessible')
    const browser = createFilesystemAccess({ root: home, desktop: false })
    const desktop = createFilesystemAccess({ root: home, desktop: true })
    assert.throws(() => browser.resolve(outside), { code: 'EOUTSIDE_ROOT' })
    await assert.rejects(() => browser.verify(outside), { code: 'EOUTSIDE_ROOT' })
    const file = await desktop.verify(desktop.resolve(path.join(outside, 'movie.txt')))
    assert.equal(await fs.readFile(file, 'utf8'), 'accessible')
    const link = path.join(home, 'mounted')
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => browser.verify(browser.resolve(link)), { code: 'EOUTSIDE_ROOT' })
    assert.equal(await desktop.verify(desktop.resolve(link)), await fs.realpath(outside))
    assert.throws(() => desktop.resolve(COMPUTER_PATH), { code: 'EINVAL' })
    assert.throws(() => browser.resolve(COMPUTER_PATH), { code: 'EINVAL' })
  } finally { await fs.rm(fixture, { recursive: true, force: true }) }
})

test('Windows drive inventory omits absent letters and retains inaccessible volumes', async () => {
  const entries = await listWindowsDrives({ stat: async (drive) => {
    if (['C:\\', 'E:\\'].includes(drive)) return { isDirectory: () => true }
    throw Object.assign(new Error('not available'), { code: drive === 'D:\\' ? 'EACCES' : 'ENOENT' })
  } })
  assert.deepEqual(entries.map((entry) => entry.path), ['C:\\', 'D:\\', 'E:\\'])
  assert.ok(entries.every((entry) => entry.type === 'drive' && entry.isDirectory))
})

test('This Computer breadcrumbs reach other drive roots and retain panel state', () => {
  const root = { name: 'This Computer', path: COMPUTER_PATH, isDirectory: true }
  const initial = { name: 'Films', path: 'E:\\Films', isDirectory: true }
  assert.deepEqual(buildPathBreadcrumbs(root, initial.path), [
    { name: 'This Computer', path: COMPUTER_PATH },
    { name: 'E:\\', path: 'E:\\' },
    { name: 'Films', path: 'E:\\Films' },
  ])
  assert.equal(isSameOrDescendantPath(COMPUTER_PATH, 'C:\\Windows'), true)
  assert.equal(isSameOrDescendantPath(COMPUTER_PATH, '/etc'), false)
  assert.equal(restorePanelViewState({ providerId: 'local', root: initial }, 'local', root, root).root, initial)
  assert.deepEqual(buildPathBreadcrumbs(root, COMPUTER_PATH), [{ name: 'This Computer', path: COMPUTER_PATH }])
  assert.deepEqual(buildPathBreadcrumbs(root, '\\\\server\\share\\Movies'), [
    { name: 'This Computer', path: COMPUTER_PATH },
    { name: '\\\\server\\share', path: '\\\\server\\share' },
    { name: 'Movies', path: '\\\\server\\share\\Movies' },
  ])
})

test('This Computer refreshes on drive attachment and releases its inventory timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let drives = ['C:\\']
  let requests = 0
  let refreshed = 0
  const registry = createDirectoryWatchRegistry({ request: async (name, payload) => {
    assert.equal(name, 'filesystem:list')
    assert.equal(payload.path, COMPUTER_PATH)
    requests += 1
    return { ok: true, entries: drives.map((drive) => ({ path: drive })) }
  } })
  const stop = registry.subscribe('local', COMPUTER_PATH, () => { refreshed += 1 })
  await new Promise(setImmediate)
  t.mock.timers.tick(3000)
  await new Promise(setImmediate)
  assert.equal(refreshed, 0)
  drives = ['C:\\', 'E:\\']
  t.mock.timers.tick(3000)
  await new Promise(setImmediate)
  assert.equal(refreshed, 1)
  stop()
  const finalRequests = requests
  t.mock.timers.tick(6000)
  await new Promise(setImmediate)
  assert.equal(requests, finalRequests)
})
