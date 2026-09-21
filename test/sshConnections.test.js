import assert from 'node:assert/strict'
import test from 'node:test'
import { connectionIdFromProvider, providerIdForConnection } from '../src/api/connections.js'
import { remoteInitialPath, SshConnectionManager, validateConnectionProfile } from '../server/ssh.js'

test('routes SFTP providers by connection ID', () => {
  assert.equal(providerIdForConnection('demo'), 'sftp:demo')
  assert.equal(connectionIdFromProvider('sftp:demo'), 'demo')
  assert.equal(connectionIdFromProvider('local'), null)
})

test('cross-provider move deletes only after a completed copy', async () => {
  const manager = new SshConnectionManager({ emit() {} })
  const events = []
  manager.connections.set('a', { status: 'connected', resolve: (value) => value, remove: async () => events.push('delete'), sftp: {} })
  manager.connections.set('b', { status: 'connected', resolve: (value) => value, sftp: {} })
  manager.copy = async () => events.push('copy')
  await manager.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' })
  assert.deepEqual(events, ['copy', 'delete'])
})

test('cross-provider move preserves the source when copy fails', async () => {
  const manager = new SshConnectionManager({ emit() {} })
  let removed = false
  manager.connections.set('a', { status: 'connected', resolve: (value) => value, remove: async () => { removed = true }, sftp: {} })
  manager.connections.set('b', { status: 'connected', resolve: (value) => value, sftp: {} })
  manager.copy = async () => { throw Object.assign(new Error('copy failed'), { code: 'ECOPY' }) }
  await assert.rejects(() => manager.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' }), { code: 'ECOPY' })
  assert.equal(removed, false)
})

test('cross-provider move reports a partial result when source cleanup fails', async () => {
  const manager = new SshConnectionManager({ emit() {} })
  manager.connections.set('a', {
    status: 'connected',
    resolve: (value) => value,
    remove: async () => { throw Object.assign(new Error('remove failed'), { code: 'EACCES' }) },
    sftp: {},
  })
  manager.connections.set('b', { status: 'connected', resolve: (value) => value, sftp: {} })
  manager.copy = async () => {}
  await assert.rejects(
    () => manager.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' }),
    (error) => error.code === 'EPARTIAL_MOVE' && error.partialResult.destinationPath === '/b/file.txt',
  )
})

test('rejects same-path and recursive same-provider SFTP transfers', async () => {
  const manager = new SshConnectionManager({ emit() {} })
  manager.connections.set('a', {
    status: 'connected',
    resolve: (value) => value,
    sftp: {
      lstat(_path, callback) { callback(null, { isDirectory: () => true }) },
    },
  })
  await assert.rejects(
    () => manager.operate({ action: 'copy', filesystemId: 'sftp:a', sourcePath: '/a/folder', targetFilesystemId: 'sftp:a', targetDirectory: '/a' }),
    { code: 'ESAMEPATH' },
  )
  await assert.rejects(
    () => manager.operate({ action: 'copy', filesystemId: 'sftp:a', sourcePath: '/a/folder', targetFilesystemId: 'sftp:a', targetDirectory: '/a/folder/child' }),
    { code: 'ECYCLE' },
  )
})

test('accepts custom SSH ports and POSIX initial paths', () => {
  const result = validateConnectionProfile({ id: 'demo', name: 'Demo', host: 'example.com', port: 2222, username: 'demo', authType: 'privateKey', privateKeyPath: '/keys/id_ed25519', initialPath: '/home/demo' })
  assert.equal(result.port, 2222)
})

test('opens remote providers at filesystem root unless an initial path is explicit', () => {
  assert.equal(remoteInitialPath({}), '/')
  assert.equal(remoteInitialPath({ initialPath: '' }), '/')
  assert.equal(remoteInitialPath({ initialPath: '/home/demo' }), '/home/demo')
  assert.equal(remoteInitialPath({ initialPath: '/var/www/example.com' }), '/var/www/example.com')
})

test('rejects invalid ports and Windows-style SFTP paths', () => {
  const base = { id: 'test', name: 'Test', host: 'example.com', username: 'demo', authType: 'password' }
  assert.throws(() => validateConnectionProfile({ ...base, port: 0 }), { code: 'EINVAL' })
  assert.throws(() => validateConnectionProfile({ ...base, port: 22, initialPath: 'C:\\remote' }), { code: 'EINVAL' })
})
