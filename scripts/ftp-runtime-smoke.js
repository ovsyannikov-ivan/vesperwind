// FTP/FTPS smoke of a real Vesperwind backend process: `node server/index.js`
// (default) or a Node SEA executable (`--sea staging/vesperwind`). It starts
// local FTP, explicit FTPS and implicit FTPS fixture servers, writes an
// isolated settings file, and drives the backend over Socket.IO like the UI:
// capabilities, connect (with certificate trust through a pin), reconnect
// without retyping the password, cancelling a hanging connect, list, read,
// transfers, the media endpoint, settings invalidation and secret hygiene.
// Nothing outside a temporary directory is read or written.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'
import { createTestPki, startFtpTestServer } from '../test/support/ftpTestServer.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seaIndex = process.argv.indexOf('--sea')
const seaExecutable = seaIndex >= 0 ? path.resolve(process.argv[seaIndex + 1] || '') : null
const PASSWORD = `smoke-${crypto.randomUUID()}`

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})
const check = (condition, message) => { if (!condition) throw new Error(message) }

const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-ftp-smoke-')))
const servers = []
let backend = null, socket = null
let output = ''
try {
  const pki = await createTestPki(workspace)
  await fs.writeFile(path.join(workspace, 'extra-ca.pem'), pki.ca)
  const remote = path.join(workspace, 'remote')
  await fs.mkdir(path.join(remote, 'docs'), { recursive: true })
  await fs.writeFile(path.join(remote, 'docs', 'readme.txt'), 'hello from the smoke fixture')
  await fs.writeFile(path.join(remote, 'clip.mp4'), crypto.randomBytes(256 * 1024))
  const users = { smoke: PASSWORD }
  const plain = await startFtpTestServer(remote, { tls: 'none', users })
  const explicit = await startFtpTestServer(remote, { tls: 'explicit', users, ...pki.selfSigned, requireSessionReuse: true })
  const implicit = await startFtpTestServer(remote, { tls: 'implicit', users, ...pki.valid, requireSessionReuse: true })
  // Accepts TCP and never answers, so a connect hangs until it is cancelled.
  const silentSockets = new Set()
  const silentServer = net.createServer((client) => { silentSockets.add(client); client.resume(); client.on('error', () => {}); client.on('close', () => silentSockets.delete(client)) })
  await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve))
  const silent = { port: silentServer.address().port, close: () => { for (const client of silentSockets) client.destroy(); return new Promise((resolve) => silentServer.close(resolve)) } }
  servers.push(plain, explicit, implicit, silent)
  const profile = (id, protocol, port, extra) => ({ id, name: id, protocol, host: 'localhost', port, username: 'smoke', authType: 'password', initialPath: '', ...extra })
  const settingsPath = path.join(workspace, 'settings.json')
  await fs.writeFile(settingsPath, JSON.stringify({ version: 9, connections: [
    profile('plain', 'ftp', plain.port, { plaintextAcknowledged: true }),
    profile('explicit', 'ftps', explicit.port, { ftpTls: 'explicit' }),
    profile('implicit', 'ftps', implicit.port, { ftpTls: 'implicit' }),
    profile('silent', 'ftp', silent.port, { host: '127.0.0.1', plaintextAcknowledged: true }),
  ] }))
  const local = path.join(workspace, 'local')
  await fs.mkdir(local)

  const port = await freePort()
  const args = ['--host', '127.0.0.1', '--port', String(port), ...(seaExecutable ? [] : ['--root', local])]
  const env = { ...process.env, VESPERWIND_SETTINGS_PATH: settingsPath, NODE_EXTRA_CA_CERTS: path.join(workspace, 'extra-ca.pem'), FILE_MANAGER_ROOT: local }
  backend = seaExecutable
    ? spawn(seaExecutable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [path.join(projectRoot, 'server', 'index.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  backend.stdout.on('data', (chunk) => { output += chunk })
  backend.stderr.on('data', (chunk) => { output += chunk })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${url}/health`)).ok) break } catch { /* starting */ }
    if (attempt > 100 || backend.exitCode !== null) throw new Error(`Backend did not start:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  socket = io(url, { transports: ['websocket'] })
  const statuses = []
  socket.on('ftp:status', (event) => statuses.push(event))
  const ask = (event, payload = {}) => socket.timeout(60_000).emitWithAck(event, payload)

  const capabilities = await ask('connections:capabilities')
  check(capabilities.ok && JSON.stringify(capabilities.capabilities.protocols) === '["sftp","ftp","ftps"]', 'capabilities must list sftp, ftp and ftps')
  check(capabilities.capabilities.credentialStore === false, 'no credential store in this runtime')

  // Plain FTP and implicit FTPS (trusted through NODE_EXTRA_CA_CERTS).
  for (const id of ['plain', 'implicit']) {
    const connected = await ask('ftp:connect', { profileId: id, password: PASSWORD })
    check(connected.ok, `${id}: ${JSON.stringify(connected.error)}`)
    const listing = await ask('filesystem:list', { filesystemId: connected.providerId, path: '/docs' })
    check(listing.ok && listing.entries[0]?.name === 'readme.txt', `${id}: listing failed`)
    const text = await ask('filesystem:read-text', { filesystemId: connected.providerId, path: '/docs/readme.txt' })
    check(text.ok && text.content === 'hello from the smoke fixture', `${id}: read failed`)
  }
  check(implicit.log.dataResumed.length > 0 && implicit.log.dataResumed.every(Boolean), 'implicit FTPS data connections must resume the TLS session')

  // Explicit FTPS with a self-signed certificate: refused with details, then pinned.
  const refused = await ask('ftp:connect', { profileId: 'explicit', password: PASSWORD })
  check(!refused.ok && refused.error.code === 'ETLS_CERTIFICATE_UNTRUSTED' && /^[0-9a-f]{64}$/.test(refused.certificate?.sha256 || ''), 'self-signed certificate must be refused with details')
  check(!explicit.sent('USER') && !explicit.sent('PASS'), 'no credentials before TLS verification')
  const settings = (await ask('settings:get')).settings
  const pinned = { ...settings, connections: settings.connections.map((item) => item.id === 'explicit' ? { ...item, tlsTrustedCertificate: refused.certificate.sha256 } : item) }
  check((await ask('settings:update', { settings: pinned })).ok, 'saving the pin failed')
  const trusted = await ask('ftp:connect', { profileId: 'explicit', password: PASSWORD })
  check(trusted.ok, `pinned explicit FTPS: ${JSON.stringify(trusted.error)}`)
  // Reconnect reuses this session's password while the profile is unchanged.
  const reconnected = await ask('ftp:connect', { profileId: 'explicit', password: '' })
  check(reconnected.ok, `reconnect without a typed password: ${JSON.stringify(reconnected.error)}`)

  // A connect that hangs in its handshake is cancelled on the backend at once.
  const started = Date.now()
  const hanging = ask('ftp:connect', { profileId: 'silent', password: PASSWORD, attemptId: 'smoke-cancel' })
  for (let attempt = 0; silentSockets.size === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
  const cancelled = await ask('ftp:cancel-connect', { attemptId: 'smoke-cancel' })
  check(cancelled.ok && cancelled.cancelled === true, `cancel-connect: ${JSON.stringify(cancelled)}`)
  const stopped = await hanging
  check(!stopped.ok && stopped.error.code === 'ECANCELLED' && Date.now() - started < 10_000, `cancelled connect: ${JSON.stringify(stopped)}`)

  // Transfers: FTP → FTPS (both remote) and FTPS → local disk, in both runtimes.
  const copied = await ask('filesystem:operate', { action: 'copy', filesystemId: 'ftp:plain', sourcePath: '/docs', targetFilesystemId: 'ftps:explicit', targetDirectory: '/docs', operationId: 'smoke-copy' })
  check(copied.ok, `FTP → FTPS copy: ${JSON.stringify(copied.error)}`)
  check(await fs.readFile(path.join(remote, 'docs', 'docs', 'readme.txt'), 'utf8') === 'hello from the smoke fixture', 'copied file differs')
  const downloaded = await ask('filesystem:operate', { action: 'copy', filesystemId: 'ftps:implicit', sourcePath: '/docs/readme.txt', targetFilesystemId: 'local', targetDirectory: local })
  check(downloaded.ok, `FTPS → local copy: ${JSON.stringify(downloaded.error)}`)
  check(await fs.readFile(path.join(local, 'readme.txt'), 'utf8') === 'hello from the smoke fixture', 'FTPS → local copy differs')

  // Media endpoint with a byte range over FTPS (REST).
  const media = await fetch(`${url}/api/media?filesystemId=ftps:implicit&path=${encodeURIComponent('/clip.mp4')}`, { headers: { range: 'bytes=100-199' } })
  const bytes = Buffer.from(await media.arrayBuffer())
  check(media.status === 206 && bytes.equals((await fs.readFile(path.join(remote, 'clip.mp4'))).subarray(100, 200)), `media range over FTPS failed (${media.status})`)

  // A saved change of the endpoint ends the session.
  const current = (await ask('settings:get')).settings
  const moved = { ...current, connections: current.connections.map((item) => item.id === 'implicit' ? { ...item, host: '127.0.0.1' } : item) }
  check((await ask('settings:update', { settings: moved })).ok, 'settings update failed')
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(statuses.some((event) => event.connectionId === 'implicit' && event.status === 'disconnected'), 'settings change did not end the FTPS session')
  check((await ask('ftp:status', { connectionId: 'implicit' })).status === 'disconnected', 'status must be disconnected after the settings change')
  check((await ask('filesystem:list', { filesystemId: 'ftp:../x', path: '/' })).error?.code === 'EFILESYSTEM_ID', 'malformed provider ids must be refused')

  // Secrets: never in the settings file, events or backend output.
  check(!(await fs.readFile(settingsPath, 'utf8')).includes(PASSWORD), 'password written to settings')
  check(!JSON.stringify(statuses).includes(PASSWORD), 'password in status events')
  check(!output.includes(PASSWORD), 'password in backend output')
  console.log(`FTP/FTPS runtime smoke passed (${seaExecutable ? `SEA ${seaExecutable}` : `node ${process.version}`})`)
} catch (error) {
  console.error(error.stack || error.message)
  if (output) console.error(`Backend output:\n${output}`)
  process.exitCode = 1
} finally {
  socket?.close()
  backend?.kill()
  for (const server of servers) await server.close()
  await fs.rm(workspace, { recursive: true, force: true })
}
