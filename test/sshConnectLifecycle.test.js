// SFTP connect lifecycle of the Node/SEA runtime against a real ssh2 SFTP
// server and a TCP server that never answers: cancellation, the newest
// attempt per profile and settings changes during the handshake.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerSshHandlers, SshConnectionManager } from '../server/ssh.js'
import { startSftpTestServer } from './support/sftpTestServer.js'

const PASSWORD = 'fixture-password'
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-ssh-lifecycle-'))
test.after(() => fs.rm(workspace, { recursive: true, force: true }))

// Accepts TCP and never sends an SSH banner: the attempt hangs until cancelled.
const startSilentServer = async () => {
  const sockets = new Set()
  const server = net.createServer((socket) => { sockets.add(socket); socket.resume(); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    accepted: () => sockets.size,
    close: () => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)) },
  }
}
const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), 'condition not reached')
}
const setup = async () => {
  const sftp = await startSftpTestServer(workspace)
  const silent = await startSilentServer()
  const statuses = []
  const ssh = new SshConnectionManager({ emit: (event, payload) => { if (event === 'ssh:status') statuses.push(payload) } })
  const profile = (port, extra = {}) => ({ id: 'box', name: 'Box', protocol: 'sftp', host: '127.0.0.1', port, username: 'fixture', authType: 'password', trustedFingerprint: sftp.fingerprint, ...extra })
  return { sftp, silent, statuses, ssh, profile, close: async () => { ssh.shutdown(); await sftp.close(); await silent.close() } }
}

test('cancel stops an SFTP attempt during its handshake at once', async () => {
  const context = await setup()
  try {
    const started = Date.now()
    const attempt = context.ssh.connect(context.profile(context.silent.port), { password: PASSWORD }, { attemptId: 'attempt-1' }).then(() => assert.fail('connected'), (error) => error)
    await waitFor(() => context.silent.accepted() === 1)
    assert.equal(context.ssh.cancel('attempt-1'), true)
    assert.equal((await attempt).code, 'ECANCELLED')
    assert.ok(Date.now() - started < 5_000, 'cancel waited for the SSH ready timeout')
    await waitFor(() => context.silent.accepted() === 0)
    assert.equal(context.ssh.cancel('attempt-1'), false)
    assert.equal(context.ssh.connections.has('box'), false)
    await assert.rejects(context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD }, { attemptId: '../x' }), { code: 'EINVAL' })
  } finally { await context.close() }
})

test('a cancelled SFTP attempt never closes the newer connection started after it', async () => {
  const context = await setup()
  try {
    // Cancel the first attempt, start the second at once: the first must
    // never register, and nothing may close the second.
    const first = context.ssh.connect(context.profile(context.silent.port), { password: PASSWORD }, { attemptId: 'first' }).then(() => 'connected', (error) => error.code)
    await waitFor(() => context.silent.accepted() === 1)
    context.ssh.cancel('first')
    const second = await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD }, { attemptId: 'second' })
    assert.equal(await first, 'ECANCELLED')
    assert.equal(second.providerId, 'sftp:box')
    assert.equal(context.ssh.cancel('first'), false, 'a late cancel of the first attempt is a no-op')
    assert.equal(context.ssh.get('sftp:box').status, 'connected')
    assert.deepEqual((await context.ssh.get('sftp:box').list('/')).map((entry) => entry.name).sort(), [])

    // Without a cancel, a newer attempt for the same profile supersedes the older one.
    const older = context.ssh.connect(context.profile(context.silent.port), { password: PASSWORD }).then(() => 'connected', (error) => error.code)
    await waitFor(() => context.silent.accepted() === 1)
    await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD })
    assert.equal(await older, 'ECANCELLED')
    assert.equal(context.ssh.get('sftp:box').status, 'connected')
  } finally { await context.close() }
})

test('a cancel that crosses a successful SFTP answer closes only that connection', async () => {
  const context = await setup()
  try {
    await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD }, { attemptId: 'won' })
    assert.equal(context.ssh.cancel('won'), true)
    assert.equal(context.ssh.connections.has('box'), false)
    // A replaced connection is not closed by its own late cancel.
    await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD }, { attemptId: 'old' })
    await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD }, { attemptId: 'new' })
    assert.equal(context.ssh.cancel('old'), false)
    assert.equal(context.ssh.get('sftp:box').status, 'connected')
  } finally { await context.close() }
})

test('a saved SFTP settings change or Disconnect stops an attempt still connecting', async () => {
  const context = await setup()
  try {
    const saved = context.profile(context.silent.port)
    const attempt = context.ssh.connect(saved, { password: PASSWORD }).then(() => 'connected', (error) => error.code)
    await waitFor(() => context.silent.accepted() === 1)
    // A rename keeps the attempt; a changed trust stops it.
    context.ssh.invalidate([saved], [{ ...saved, name: 'Renamed' }])
    assert.equal(context.silent.accepted(), 1)
    context.ssh.invalidate([saved], [{ ...saved, trustedFingerprint: 'SHA256:other' }])
    assert.equal(await attempt, 'ESSH_PROFILE_CHANGED')

    const disconnected = context.ssh.connect(saved, { password: PASSWORD }).then(() => 'connected', (error) => error.code)
    await waitFor(() => context.silent.accepted() === 1)
    context.ssh.disconnect('box')
    assert.equal(await disconnected, 'ECANCELLED')
  } finally { await context.close() }
})

test('the ssh:cancel-connect event stops a pending ssh:connect, shared by every socket', async () => {
  const context = await setup()
  try {
    const connections = new Map()
    const socket = () => {
      const handlers = new Map()
      registerSshHandlers({ on: (event, handler) => handlers.set(event, handler), emit() {} }, { connections })
      return (event, payload) => new Promise((resolve) => handlers.get(event)(payload, resolve))
    }
    const [first, second] = [socket(), socket()]
    const pending = first('ssh:connect', { profile: context.profile(context.silent.port), secrets: { password: PASSWORD }, attemptId: 'socket-attempt' })
    await waitFor(() => context.silent.accepted() === 1)
    // Another window of the same backend can cancel it too.
    assert.deepEqual(await second('ssh:cancel-connect', { attemptId: 'socket-attempt' }), { ok: true, cancelled: true })
    const response = await pending
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'ECANCELLED')
    assert.deepEqual(await first('ssh:cancel-connect', { attemptId: 'unknown' }), { ok: true, cancelled: false })
  } finally { await context.close() }
})

test('parallel automatic reconnects of a lost SFTP connection share one attempt', async () => {
  const context = await setup()
  try {
    await context.ssh.connect(context.profile(context.sftp.port), { password: PASSWORD })
    context.ssh.connections.get('box').client.end()
    await waitFor(() => context.ssh.connections.get('box').status === 'disconnected')
    // Two file operations after the loss: neither may cancel the other.
    const [first, second] = await Promise.all([context.ssh.ensure('sftp:box'), context.ssh.ensure('sftp:box')])
    assert.equal(first, second)
    assert.equal(first.status, 'connected')
  } finally { await context.close() }
})
