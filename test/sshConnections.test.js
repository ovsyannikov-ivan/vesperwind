import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import { connectionIdFromProvider, providerIdForConnection } from '../src/api/connections.js'
import { remoteInitialPath, sessionAuthOptions, SshConnectionManager, validateConnectionProfile } from '../server/ssh.js'
import { registerConnectionHandlers } from '../server/connections.js'
import { RemoteProviders } from '../server/remoteProviders.js'

test('routes SFTP providers by connection ID', () => {
  assert.equal(providerIdForConnection('demo'), 'sftp:demo')
  assert.equal(connectionIdFromProvider('sftp:demo'), 'demo')
  assert.equal(connectionIdFromProvider('local'), null)
})

test('browser/SEA reports all three protocols but no secure credential storage or SSH config, without exposing secrets', () => {
  const handlers = new Map()
  registerConnectionHandlers({ on: (event, fn) => handlers.set(event, fn), emit() {} }, { ftp: {} })
  let response
  handlers.get('connections:capabilities')({}, value => { response = value })
  assert.equal(response.capabilities.credentialStore, false)
  assert.equal(response.capabilities.sshConfig, false)
  assert.deepEqual(response.capabilities.protocols, ['sftp', 'ftp', 'ftps'])
  handlers.get('connections:credential-status')({ profileId: 'test' }, value => { response = value })
  assert.equal(response.error.code, 'ECREDENTIAL_UNAVAILABLE')
  assert.equal('secret' in response, false)
})

test('explicit Password auth never tries keys/agent; a multi-prompt challenge is not given the password', async () => {
  const auth = await sessionAuthOptions({ authType: 'password', username: 'fixture' }, { password: 'fixture' })
  assert.equal(auth.authHandler().type, 'password')
  const interactive = auth.authHandler()
  assert.equal(interactive.type, 'keyboard-interactive')
  let answers
  interactive.prompt('', '', '', [{ prompt: 'Password:', echo: false }, { prompt: 'OTP:', echo: false }], value => { answers = value })
  assert.deepEqual(answers, ['', ''])
  assert.equal(auth.failure().needs, 'interaction')
  assert.equal(auth.authHandler(), false)
})

test('rejects unsupported MFA even when a server accepts empty responses', async () => {
  const keys = ssh2.utils.generateKeyPairSync('ed25519')
  const key = ssh2.utils.parseKey(keys.public)
  const fingerprint = `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  const clients = new Set()
  let answers
  const server = new ssh2.Server({ hostKeys: [keys.private] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', context => {
      if (context.method !== 'keyboard-interactive') return context.reject(['keyboard-interactive'])
      context.prompt([{ prompt: 'Password:', echo: false }, { prompt: 'OTP:', echo: false }], values => {
        answers = values
        context.accept()
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const manager = new SshConnectionManager({ emit() {} })
    await assert.rejects(manager.connect({ id: 'mfa-fixture', name: 'MFA fixture', host: '127.0.0.1', port: server.address().port,
      username: 'fixture', authType: 'password', trustedFingerprint: fingerprint }, { password: 'never-send-to-mfa' }),
    error => error.code === 'EAUTHENTICATION_REQUIRED' && error.auth.needs === 'interaction')
    assert.deepEqual(answers, ['', ''])
  } finally {
    for (const client of clients) client.end()
    await new Promise(resolve => server.close(resolve))
  }
})

// Endpoints of the unified provider dispatch (server/remoteProviders.js).
const endpoint = (extra = {}) => ({ resolve: (value) => value, stat: async () => ({ isDirectory: false }), ...extra })
const providersWith = (connections) => new RemoteProviders({ ssh: { ensure: async (id) => connections[id], get: (id) => connections[id] } })

test('cross-provider move deletes only after a completed copy', async () => {
  const events = []
  const providers = providersWith({ 'sftp:a': endpoint({ remove: async () => events.push('delete') }), 'sftp:b': endpoint() })
  providers.copy = async () => events.push('copy')
  await providers.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' })
  assert.deepEqual(events, ['copy', 'delete'])
})

test('cross-provider move preserves the source when copy fails', async () => {
  let removed = false
  const providers = providersWith({ 'sftp:a': endpoint({ remove: async () => { removed = true } }), 'sftp:b': endpoint() })
  providers.copy = async () => { throw Object.assign(new Error('copy failed'), { code: 'ECOPY' }) }
  await assert.rejects(() => providers.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' }), { code: 'ECOPY' })
  assert.equal(removed, false)
})

test('cross-provider move reports a partial result when source cleanup fails', async () => {
  const providers = providersWith({
    'sftp:a': endpoint({ remove: async () => { throw Object.assign(new Error('remove failed'), { code: 'EACCES' }) } }),
    'sftp:b': endpoint(),
  })
  providers.copy = async () => {}
  await assert.rejects(
    () => providers.operate({ action: 'move', filesystemId: 'sftp:a', sourcePath: '/a/file.txt', targetFilesystemId: 'sftp:b', targetDirectory: '/b' }),
    (error) => error.code === 'EPARTIAL_MOVE' && error.partialResult.destinationPath === '/b/file.txt',
  )
})

test('rejects same-path and recursive same-provider SFTP transfers', async () => {
  const providers = providersWith({ 'sftp:a': endpoint({ stat: async () => ({ isDirectory: true }) }) })
  await assert.rejects(
    () => providers.operate({ action: 'copy', filesystemId: 'sftp:a', sourcePath: '/a/folder', targetFilesystemId: 'sftp:a', targetDirectory: '/a' }),
    { code: 'ESAMEPATH' },
  )
  await assert.rejects(
    () => providers.operate({ action: 'copy', filesystemId: 'sftp:a', sourcePath: '/a/folder', targetFilesystemId: 'sftp:a', targetDirectory: '/a/folder/child' }),
    { code: 'ECYCLE' },
  )
})

test('unknown or malformed providers are EFILESYSTEM_ID, never SFTP', async () => {
  const providers = new RemoteProviders({ ssh: { ensure: async () => assert.fail('not SSH') }, ftp: { get: () => assert.fail('not FTP') } })
  for (const id of ['ssh:test', 'smb:share', 'sftp:', 'ftp:../x', 'ftps:a b', 'webdav:x', ':x', 42]) {
    await assert.rejects(() => providers.ensure(id), { code: 'EFILESYSTEM_ID' }, String(id))
  }
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
  // FTP/FTPS and unknown protocols are never accepted as SSH profiles.
  for (const protocol of ['ftp', 'ftps', '', 'SFTP']) {
    assert.throws(() => validateConnectionProfile({ ...base, port: 21, authType: 'password', protocol }), { code: 'EINVAL' })
  }
  assert.equal(validateConnectionProfile({ ...base, port: 22, protocol: 'sftp' }).port, 22)
})
