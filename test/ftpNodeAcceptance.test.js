// Node/SEA FTP and FTPS acceptance against real local servers: the FTP/FTPS
// server of test/support/ftpTestServer.js (plain, explicit and implicit TLS
// with a synthetic PKI and fault injection) and an ssh2 SFTP server. Every
// scenario runs the production modules (server/ftp.js, server/ssh.js,
// server/remoteProviders.js); nothing here is a mock of FTP.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTestPki, startFtpTestServer } from './support/ftpTestServer.js'
import { startSftpTestServer } from './support/sftpTestServer.js'

// The real path: the guarded local root must not sit behind a symlink (/var → /private/var).
const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-ftp-node-')))
const localRoot = path.join(workspace, 'local')
await fs.mkdir(localRoot)
// server/filesystem.js reads its guarded root when it is first imported.
process.env.FILE_MANAGER_ROOT = localRoot
const { FtpConnectionManager, certificateFingerprint, parseListing } = await import('../server/ftp.js')
const { SshConnectionManager } = await import('../server/ssh.js')
const { RemoteProviders, localChild } = await import('../server/remoteProviders.js')
const { registerConnectionHandlers } = await import('../server/connections.js')

const PASSWORD = 'fixture-password'
const pki = await createTestPki(workspace)
const selfSignedPin = certificateFingerprint(Buffer.from(new crypto.X509Certificate(pki.selfSigned.cert).raw))
const validPin = certificateFingerprint(Buffer.from(new crypto.X509Certificate(pki.valid.cert).raw))
test.after(() => fs.rm(workspace, { recursive: true, force: true }))

// Everything the backend prints is collected and searched for secrets.
const printed = []
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[method]
  console[method] = (...values) => { printed.push(values.map(String).join(' ')); original.apply(console, values) }
}

let serial = 0
const freshRoot = async (files = {}) => {
  const root = path.join(workspace, `remote-${++serial}`)
  await fs.mkdir(root)
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    if (content === null) await fs.mkdir(path.join(root, name), { recursive: true })
    else await fs.writeFile(path.join(root, name), content)
  }
  return root
}

const profileFor = (server, tlsMode, extra = {}) => ({
  id: `p${++serial}`, name: 'Fixture', host: 'localhost', port: server.port, username: 'fixture', authType: 'password',
  initialPath: '', ftpDataMode: 'passive', ftpEncoding: 'utf-8', savePassword: false,
  ...(tlsMode === 'none' ? { protocol: 'ftp', plaintextAcknowledged: true } : { protocol: 'ftps', ftpTls: tlsMode, tlsTrustedCertificate: '' }),
  ...extra,
})

const setup = async ({ tls = 'explicit', cert = pki.valid, files = { 'a.txt': 'hello world' }, server: serverOptions = {}, profile: profileExtra = {}, manager: managerOptions = {} } = {}) => {
  const root = await freshRoot(files)
  const server = await startFtpTestServer(root, { tls, ...cert, requireSessionReuse: tls !== 'none', ...serverOptions })
  const profile = profileFor(server, tls, profileExtra)
  const profiles = new Map([[profile.id, profile]])
  const events = []
  const ftp = new FtpConnectionManager({ loadProfile: async (id) => profiles.get(id), emitStatus: (event) => events.push(event), extraCa: [pki.ca], ...managerOptions })
  const providers = new RemoteProviders({ ftp })
  return { root, server, profile, profiles, events, ftp, providers, providerId: `${profile.protocol}:${profile.id}`,
    close: async () => { ftp.shutdown(); await server.close() } }
}

const assertNoCredentialsSent = (server) => {
  assert.equal(server.sent('USER'), false, 'USER was sent')
  assert.equal(server.sent('PASS'), false, 'PASS was sent')
}

test('plain FTP with a password and Anonymous connect, list, read and write', async () => {
  const context = await setup({ tls: 'none', files: { 'a.txt': 'hello', 'Папка/файл с пробелом.txt': 'юникод' } })
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    assert.equal(result.providerId, `ftp:${context.profile.id}`)
    assert.deepEqual(context.events.map((event) => event.status), ['connected'])
    const connection = context.ftp.get(result.providerId)
    assert.deepEqual((await connection.list('/')).map((entry) => entry.name), ['Папка', 'a.txt'])
    assert.equal((await connection.readText('/Папка/файл с пробелом.txt')).content, 'юникод')
    await connection.writeText('/a.txt', 'changed')
    assert.equal(await fs.readFile(path.join(context.root, 'a.txt'), 'utf8'), 'changed')
    context.ftp.disconnect(context.profile.id)
    assert.deepEqual(context.events.map((event) => event.status), ['connected', 'disconnected'])
    // The session-only password is dropped with the connection.
    assert.equal(connection.password, '')
    assert.throws(() => context.ftp.get(result.providerId), { code: 'EFTP_DISCONNECTED' })

    context.profiles.set(context.profile.id, { ...context.profile, authType: 'anonymous', username: 'anonymous' })
    await context.ftp.connect(context.profile.id, '')
    assert.ok(context.server.log.commands.includes('USER anonymous'))
  } finally { await context.close() }
})

test('plain FTP needs the saved acknowledgement and never falls back from FTPS', async () => {
  const context = await setup({ tls: 'none', profile: { plaintextAcknowledged: false } })
  try {
    await assert.rejects(context.ftp.connect(context.profile.id, PASSWORD), { code: 'EFTP_PLAINTEXT_NOT_ACKNOWLEDGED' })
    assert.equal(context.server.log.accepted, 0)
  } finally { await context.close() }
  // An FTPS profile against a server without AUTH TLS stops; it does not continue in clear text.
  const plainServer = await setup({ tls: 'explicit', server: { rejectAuthTls: true } })
  try {
    await assert.rejects(plainServer.ftp.connect(plainServer.profile.id, PASSWORD), { code: 'EFTPS_AUTH_TLS_REJECTED' })
    assertNoCredentialsSent(plainServer.server)
  } finally { await plainServer.close() }
})

for (const tls of ['explicit', 'implicit']) {
  test(`${tls} FTPS: trusted chain, protected data channel and TLS session reuse`, async () => {
    const context = await setup({ tls, files: { 'a.txt': 'secure', 'dir/b.bin': crypto.randomBytes(300_000) } })
    try {
      const result = await context.ftp.connect(context.profile.id, PASSWORD)
      assert.equal(result.providerId, `ftps:${context.profile.id}`)
      const connection = context.ftp.get(result.providerId)
      assert.deepEqual((await connection.list('/')).map((entry) => entry.name), ['dir', 'a.txt'])
      assert.equal((await connection.readText('/a.txt')).content, 'secure')
      const binary = await connection.readBinary('/dir/b.bin')
      assert.deepEqual(Buffer.from(binary.base64, 'base64'), await fs.readFile(path.join(context.root, 'dir/b.bin')))
      // The server refuses unprotected or non-resumed data connections.
      assert.ok(context.server.log.commands.includes('PROT P'))
      assert.ok(context.server.log.dataResumed.length >= 3 && context.server.log.dataResumed.every(Boolean))
      const order = context.server.log.commands
      if (tls === 'explicit') assert.ok(order.indexOf('AUTH TLS') < order.findIndex((line) => line.startsWith('USER')))
      assert.ok(order.indexOf('PROT P') < order.findIndex((line) => line.startsWith('USER')))
    } finally { await context.close() }
  })

  test(`${tls} FTPS: untrusted, wrong-host and expired certificates stop before USER/PASS with details`, async () => {
    for (const [cert, code, reason] of [
      [pki.selfSigned, 'ETLS_CERTIFICATE_UNTRUSTED', 'untrusted'],
      [pki.wrongHost, 'ETLS_CERTIFICATE_HOSTNAME', 'hostname'],
      [pki.expired, 'ETLS_CERTIFICATE_EXPIRED', 'expired'],
    ]) {
      const context = await setup({ tls, cert })
      try {
        const failure = await context.ftp.connect(context.profile.id, PASSWORD).then(() => assert.fail('connected'), (error) => error)
        assert.equal(failure.code, code)
        assertNoCredentialsSent(context.server)
        const details = failure.certificate
        assert.equal(details.reason, reason)
        assert.equal(details.endpoint, `localhost:${context.server.port}`)
        assert.match(details.sha256, /^[0-9a-f]{64}$/)
        assert.equal(details.sha256, certificateFingerprint(Buffer.from(new crypto.X509Certificate(cert.cert).raw)))
        assert.match(details.subject, /CN=/)
        assert.match(details.issuer, /CN=/)
        assert.ok(details.notBefore && details.notAfter)
        assert.ok(Array.isArray(details.dnsNames) && Array.isArray(details.ipAddresses))
        assert.equal(JSON.stringify(failure).includes(PASSWORD), false)
      } finally { await context.close() }
    }
  })

  test(`${tls} FTPS: an explicitly pinned certificate connects; a changed one is refused with both fingerprints`, async () => {
    const pinned = await setup({ tls, cert: pki.selfSigned, profile: { tlsTrustedCertificate: selfSignedPin } })
    try {
      const result = await pinned.ftp.connect(pinned.profile.id, PASSWORD)
      const connection = pinned.ftp.get(result.providerId)
      assert.equal((await connection.readText('/a.txt')).content, 'hello world')
      // Data connections are checked against the pin as well (here: resumed).
      assert.ok(pinned.server.log.dataResumed.every(Boolean))
    } finally { await pinned.close() }
    // A pin replaces chain checks for exactly one certificate: even a
    // CA-valid certificate is refused when it is not the pinned one.
    const changed = await setup({ tls, cert: pki.valid, profile: { tlsTrustedCertificate: selfSignedPin } })
    try {
      const failure = await changed.ftp.connect(changed.profile.id, PASSWORD).then(() => assert.fail('connected'), (error) => error)
      assert.equal(failure.code, 'ETLS_CERTIFICATE_CHANGED')
      assert.equal(failure.certificate.reason, 'changed')
      assert.equal(failure.certificate.pinnedSha256, selfSignedPin)
      assert.equal(failure.certificate.sha256, validPin)
      assertNoCredentialsSent(changed.server)
    } finally { await changed.close() }
  })

  test(`${tls} FTPS: a data connection with another certificate is refused before any file data is sent`, async () => {
    for (const [profile, dataCert] of [[{ tlsTrustedCertificate: selfSignedPin }, pki.valid], [{}, pki.wrongHost]]) {
      const cert = profile.tlsTrustedCertificate ? pki.selfSigned : pki.valid
      const context = await setup({ tls, cert, profile, server: { dataCert, requireSessionReuse: false } })
      try {
        const result = await context.ftp.connect(context.profile.id, PASSWORD)
        const connection = context.ftp.get(result.providerId)
        await assert.rejects(connection.list('/'), (error) => error.code.startsWith('ETLS'))
        await fs.writeFile(path.join(localRoot, 'secret.txt'), 'confidential upload')
        await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: 'local', sourcePath: path.join(localRoot, 'secret.txt'), targetFilesystemId: result.providerId, targetDirectory: '/' }), (error) => error.code.startsWith('ETLS'))
        assert.equal(context.server.log.received, 0)
        assert.equal(context.server.log.dataResumed.some(Boolean), false)
      } finally { await context.close(); await fs.rm(path.join(localRoot, 'secret.txt'), { force: true }) }
    }
  })

  test(`${tls} FTPS: a refused PROT P stops before USER/PASS`, async () => {
    const context = await setup({ tls, server: { rejectProtP: true } })
    try {
      await assert.rejects(context.ftp.connect(context.profile.id, PASSWORD), { code: 'EFTPS_PROT_P_REJECTED' })
      assertNoCredentialsSent(context.server)
    } finally { await context.close() }
  })
}

test('the IP address of a certificate SAN is verified without SNI', async () => {
  const context = await setup({ tls: 'explicit' })
  try {
    context.profiles.set(context.profile.id, { ...context.profile, host: '127.0.0.1' })
    await context.ftp.connect(context.profile.id, PASSWORD)
  } finally { await context.close() }
})

test('wrong password, missing password and malformed requests', async () => {
  const context = await setup({ tls: 'explicit' })
  try {
    const failure = await context.ftp.connect(context.profile.id, 'wrong').then(() => assert.fail('connected'), (error) => error)
    assert.equal(failure.code, 'EAUTHENTICATION_REQUIRED')
    assert.deepEqual(failure.auth, { needs: 'password' })
    assert.equal(failure.message.includes('Login incorrect'), false)
    await assert.rejects(context.ftp.connect(context.profile.id, ''), (error) => error.code === 'EAUTHENTICATION_REQUIRED' && error.auth.needs === 'password')
    await assert.rejects(context.ftp.connect('../etc', PASSWORD), { code: 'EINVAL' })
    await assert.rejects(context.ftp.connect('missing-profile', PASSWORD), { code: 'ENOENT' })
    await assert.rejects(context.ftp.connect(context.profile.id, 'a\r\nDELE /a.txt'), { code: 'EINVAL' })
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    // The scheme must match the saved protocol; ids are never guessed.
    for (const id of [`ftp:${context.profile.id}`, `sftp:${context.profile.id}`, 'ftps:', 'ftps:../x', 'ftp', 'webdav:x']) {
      await assert.rejects(context.providers.ensure(id), (error) => ['EFILESYSTEM_ID', 'EFTP_DISCONNECTED', 'ESSH_DISCONNECTED'].includes(error.code), id)
    }
    await assert.rejects(context.providers.ensure('webdav:x'), { code: 'EFILESYSTEM_ID' })
    const connection = context.ftp.get(result.providerId)
    await assert.rejects(connection.list('relative'), { code: 'EINVAL' })
    await assert.rejects(connection.list('/a\r\nDELE /a.txt'), { code: 'EINVAL' })
    await assert.rejects(connection.readText('/a\\b'), { code: 'EINVAL' })
  } finally { await context.close() }
})

test('final 451/552 replies after all bytes fail the transfer and partial files are removed', async () => {
  const context = await setup({ tls: 'explicit', server: { retrFinalError: 451, storFinalError: 552 }, files: { 'a.txt': 'payload' } })
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    await assert.rejects(context.ftp.get(result.providerId).readText('/a.txt'), { code: 'EFTP_TRANSFER' })
    // Download to local: the local partial file is removed.
    await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/a.txt', targetFilesystemId: 'local', targetDirectory: localRoot }), { code: 'EFTP_TRANSFER' })
    await assert.rejects(fs.access(path.join(localRoot, 'a.txt')))
    // Upload: the server stored all bytes, then refused; the partial remote file is removed.
    await fs.writeFile(path.join(localRoot, 'up.txt'), 'upload body')
    await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: 'local', sourcePath: path.join(localRoot, 'up.txt'), targetFilesystemId: result.providerId, targetDirectory: '/' }), { code: 'EFTP_TRANSFER' })
    await assert.rejects(fs.access(path.join(context.root, 'up.txt')))
    // STOR/DELE/RNFR/RNTO are never repeated.
    assert.equal(context.server.log.commands.filter((line) => line === 'STOR /up.txt').length, 1)
  } finally { await context.close(); await fs.rm(path.join(localRoot, 'up.txt'), { force: true }) }
})

test('cancelling mid-file stops the transfer and removes the partial destination', async () => {
  const big = crypto.randomBytes(4 * 1024 * 1024)
  const context = await setup({ tls: 'explicit', files: { 'a.txt': 'hello world', 'big.bin': big }, server: { throttle: 512 * 1024 } })
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 700)
    const started = Date.now()
    await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/big.bin', targetFilesystemId: 'local', targetDirectory: localRoot }, { signal: controller.signal }), { code: 'ECANCELLED' })
    assert.ok(Date.now() - started < 5000)
    await assert.rejects(fs.access(path.join(localRoot, 'big.bin')))
    // Upload cancel: the partial remote file is removed.
    await fs.writeFile(path.join(localRoot, 'up.bin'), big)
    const upload = new AbortController()
    setTimeout(() => upload.abort(), 700)
    await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: 'local', sourcePath: path.join(localRoot, 'up.bin'), targetFilesystemId: result.providerId, targetDirectory: '/' }, { signal: upload.signal }), { code: 'ECANCELLED' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await assert.rejects(fs.access(path.join(context.root, 'up.bin')))
    // The connection stays usable after cancellations.
    assert.equal((await context.ftp.get(result.providerId).readText('/a.txt')).content, 'hello world')
  } finally { await context.close(); await fs.rm(path.join(localRoot, 'up.bin'), { force: true }) }
})

test('a stalled transfer times out and a server disconnect during a transfer fails cleanly', async () => {
  const context = await setup({ tls: 'none', files: { 'big.bin': crypto.randomBytes(2 * 1024 * 1024) }, server: { stallRetrAfter: 256 * 1024 }, manager: { idleTimeout: 1000 } })
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/big.bin', targetFilesystemId: 'local', targetDirectory: localRoot }), { code: 'ETIMEDOUT' })
    await assert.rejects(fs.access(path.join(localRoot, 'big.bin')))
  } finally { await context.close() }
  const dropped = await setup({ tls: 'explicit', files: { 'big.bin': crypto.randomBytes(4 * 1024 * 1024) }, server: { throttle: 512 * 1024 } })
  try {
    const result = await dropped.ftp.connect(dropped.profile.id, PASSWORD)
    setTimeout(() => dropped.server.close(), 500)
    const failure = await dropped.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/big.bin', targetFilesystemId: 'local', targetDirectory: localRoot }).then(() => assert.fail('copied'), (error) => error)
    assert.ok(['EFTP_DISCONNECTED', 'EFTP_TRANSFER', 'ETIMEDOUT'].includes(failure.code), failure.code)
    await assert.rejects(fs.access(path.join(localRoot, 'big.bin')))
  } finally { await dropped.close() }
})

test('large transfers stream in both directions without buffering whole files', async () => {
  const size = 96 * 1024 * 1024
  const context = await setup({ tls: 'explicit', files: {} })
  const source = path.join(localRoot, 'large.bin')
  const handle = await fs.open(source, 'w')
  const block = crypto.randomBytes(1024 * 1024)
  for (let offset = 0; offset < size; offset += block.length) await handle.write(block)
  await handle.close()
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    // Peak memory is sampled while the transfers run (client and server share this process).
    const before = process.memoryUsage().rss
    let peak = before
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 20)
    try {
      await context.providers.operate({ action: 'copy', filesystemId: 'local', sourcePath: source, targetFilesystemId: result.providerId, targetDirectory: '/' })
      assert.equal((await fs.stat(path.join(context.root, 'large.bin'))).size, size)
      await fs.mkdir(path.join(localRoot, 'back'))
      await context.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/large.bin', targetFilesystemId: 'local', targetDirectory: path.join(localRoot, 'back') })
    } finally { clearInterval(sampler) }
    // Streaming: memory grows far less than the file size during transfers.
    assert.ok(peak - before < size / 2, `RSS grew by ${peak - before}`)
    const digest = async (file) => {
      const hash = crypto.createHash('sha256')
      for await (const part of (await import('node:fs')).createReadStream(file)) hash.update(part)
      return hash.digest('hex')
    }
    assert.equal(await digest(path.join(localRoot, 'back', 'large.bin')), await digest(source))
  } finally {
    await context.close()
    await fs.rm(source, { force: true }); await fs.rm(path.join(localRoot, 'back'), { recursive: true, force: true })
  }
})

test('concurrent listings and transfers share a bounded session pool', async () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${index}.txt`, `file ${index}`]))
  const context = await setup({ tls: 'explicit', files })
  try {
    const result = await context.ftp.connect(context.profile.id, PASSWORD)
    const connection = context.ftp.get(result.providerId)
    const work = []
    for (let index = 0; index < 8; index++) {
      work.push(connection.readText(`/f${index}.txt`).then((value) => value.content))
      work.push(connection.list('/').then((entries) => entries.length))
    }
    const values = await Promise.all(work)
    assert.deepEqual(values.filter((value) => typeof value === 'string'), Array.from({ length: 8 }, (_, index) => `file ${index}`))
    assert.ok(values.filter((value) => typeof value === 'number').every((count) => count === 8))
    assert.ok(context.server.log.peak <= 4, `peak ${context.server.log.peak}`)
    // A server-side idle timeout on pooled sessions is recovered for repeatable operations.
    connection.severIdle()
    assert.equal((await connection.list('/')).length, 8)
  } finally { await context.close() }
})

test('local ↔ FTPS and FTP ↔ SFTP copy, move, rename, create and delete', async () => {
  const ftpsContext = await setup({ tls: 'explicit', files: { 'tree/a.txt': 'A', 'tree/sub/b.txt': 'B', 'tree/empty': null } })
  const sftpRoot = await freshRoot({ 'from-sftp/c.txt': 'C' })
  const sftpServer = await startSftpTestServer(sftpRoot)
  const ssh = new SshConnectionManager({ emit() {} })
  const providers = new RemoteProviders({ ssh, ftp: ftpsContext.ftp })
  try {
    const ftps = (await ftpsContext.ftp.connect(ftpsContext.profile.id, PASSWORD)).providerId
    const sftp = (await ssh.connect({ id: 'sftp-fixture', name: 'SFTP', host: '127.0.0.1', port: sftpServer.port, username: 'fixture', authType: 'password', trustedFingerprint: sftpServer.fingerprint }, { password: PASSWORD })).providerId
    // FTPS → local (recursive), local → FTPS
    await providers.operate({ action: 'copy', filesystemId: ftps, sourcePath: '/tree', targetFilesystemId: 'local', targetDirectory: localRoot })
    assert.equal(await fs.readFile(path.join(localRoot, 'tree/sub/b.txt'), 'utf8'), 'B')
    assert.ok((await fs.stat(path.join(localRoot, 'tree/empty'))).isDirectory())
    await providers.operate({ action: 'copy', filesystemId: 'local', sourcePath: path.join(localRoot, 'tree'), targetFilesystemId: ftps, targetDirectory: '/tree/sub', name: undefined })
    assert.equal(await fs.readFile(path.join(ftpsContext.root, 'tree/sub/tree/a.txt'), 'utf8'), 'A')
    // FTPS → SFTP and SFTP → FTPS
    await providers.operate({ action: 'copy', filesystemId: ftps, sourcePath: '/tree/sub', targetFilesystemId: sftp, targetDirectory: '/' })
    assert.equal(await fs.readFile(path.join(sftpRoot, 'sub/tree/sub/b.txt'), 'utf8'), 'B')
    await providers.operate({ action: 'move', filesystemId: sftp, sourcePath: '/from-sftp', targetFilesystemId: ftps, targetDirectory: '/' })
    assert.equal(await fs.readFile(path.join(ftpsContext.root, 'from-sftp/c.txt'), 'utf8'), 'C')
    await assert.rejects(fs.access(path.join(sftpRoot, 'from-sftp')))
    // An existing destination is never overwritten.
    await assert.rejects(providers.operate({ action: 'copy', filesystemId: sftp, sourcePath: '/sub', targetFilesystemId: ftps, targetDirectory: '/tree' }), { code: 'EEXIST' })
    // Same-connection rename/move, create, delete; root and cycles are refused.
    await providers.operate({ action: 'rename', filesystemId: ftps, sourcePath: '/from-sftp/c.txt', name: 'renamed.txt' })
    await providers.operate({ action: 'move', filesystemId: ftps, sourcePath: '/from-sftp/renamed.txt', targetFilesystemId: ftps, targetDirectory: '/tree' })
    assert.equal(await fs.readFile(path.join(ftpsContext.root, 'tree/renamed.txt'), 'utf8'), 'C')
    await assert.rejects(providers.operate({ action: 'move', filesystemId: ftps, sourcePath: '/tree', targetFilesystemId: ftps, targetDirectory: '/tree/sub' }), { code: 'ECYCLE' })
    await providers.operate({ action: 'create-folder', targetFilesystemId: ftps, targetDirectory: '/', name: 'new folder' })
    await providers.operate({ action: 'create-file', targetFilesystemId: ftps, targetDirectory: '/new folder', name: 'empty.txt' })
    assert.equal((await fs.stat(path.join(ftpsContext.root, 'new folder/empty.txt'))).size, 0)
    await assert.rejects(providers.operate({ action: 'create-folder', targetFilesystemId: ftps, targetDirectory: '/', name: '../escape' }), { code: 'EINVALID_NAME' })
    await providers.operate({ action: 'delete', filesystemId: ftps, sourcePath: '/tree' })
    await assert.rejects(fs.access(path.join(ftpsContext.root, 'tree')))
    await assert.rejects(providers.operate({ action: 'delete', filesystemId: ftps, sourcePath: '/' }), { code: 'EROOT_OPERATION' })
  } finally {
    ssh.shutdown(); await sftpServer.close(); await ftpsContext.close()
    await fs.rm(path.join(localRoot, 'tree'), { recursive: true, force: true })
  }
})

test('hostile MLSD and LIST names are hidden and stop recursive operations before anything is created', async () => {
  const hostile = ['../outside.txt', '..\\..\\outside.txt', '/etc/passwd', 'a/b', 'C:\\Windows\\win.ini', 'bell\u0007', '..']
  for (const mlsd of [true, false]) {
    const context = await setup({
      tls: 'explicit', files: { 'dir/ok.txt': 'ok' },
      server: mlsd
        ? { extraMlsd: hostile.map((name) => `type=file;size=1; ${name}`) }
        : { mlsd: false, extraList: hostile.map((name) => `-rw-r--r--    1 o g 1 Jan 02 15:04 ${name}`) },
    })
    try {
      const result = await context.ftp.connect(context.profile.id, PASSWORD)
      const connection = context.ftp.get(result.providerId)
      assert.deepEqual((await connection.list('/dir')).map((entry) => entry.name), ['ok.txt'])
      await assert.rejects(context.providers.operate({ action: 'copy', filesystemId: result.providerId, sourcePath: '/dir', targetFilesystemId: 'local', targetDirectory: localRoot }), { code: 'EUNSAFE_NAME' })
      await assert.rejects(fs.access(path.join(localRoot, 'dir')))
      await assert.rejects(context.providers.operate({ action: 'delete', filesystemId: result.providerId, sourcePath: '/dir' }), { code: 'EUNSAFE_NAME' })
      assert.equal(await fs.readFile(path.join(context.root, 'dir/ok.txt'), 'utf8'), 'ok')
      assert.equal(context.server.log.commands.some((line) => line.startsWith('DELE')), false)
    } finally { await context.close() }
  }
  const listing = parseListing('type=file;size=1;  leading space.txt\r\ntype=file;size=1; ../x\r\n', true)
  assert.deepEqual([listing.entries.map((entry) => entry.name), listing.rejected], [[' leading space.txt'], 1])
})

test('hostile SFTP names stop recursive SFTP operations as well', async () => {
  const root = await freshRoot({ 'dir/ok.txt': 'ok' })
  const sftpServer = await startSftpTestServer(root, { extraNames: ['../../outside'] })
  const ssh = new SshConnectionManager({ emit() {} })
  const providers = new RemoteProviders({ ssh })
  try {
    const sftp = (await ssh.connect({ id: 'sftp-hostile', name: 'SFTP', host: '127.0.0.1', port: sftpServer.port, username: 'fixture', authType: 'password', trustedFingerprint: sftpServer.fingerprint }, { password: PASSWORD })).providerId
    await assert.rejects(providers.operate({ action: 'copy', filesystemId: sftp, sourcePath: '/dir', targetFilesystemId: 'local', targetDirectory: localRoot }), { code: 'EUNSAFE_NAME' })
    await assert.rejects(providers.operate({ action: 'delete', filesystemId: sftp, sourcePath: '/dir' }), { code: 'EUNSAFE_NAME' })
    assert.equal(await fs.readFile(path.join(root, 'dir/ok.txt'), 'utf8'), 'ok')
  } finally { ssh.shutdown(); await sftpServer.close() }
})

test('Windows local name rules refuse drive-relative, stream and reserved names', () => {
  for (const name of ['C:evil.txt', 'name:stream', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'trailing.', 'trailing ', '..\\up', 'con\u0001']) {
    assert.throws(() => localChild('C:\\Users\\fixture\\Downloads', name, 'win32'), { code: 'EUNSAFE_NAME' }, name)
  }
  assert.equal(localChild('C:\\Users\\fixture', 'report 2026.txt', 'win32'), 'C:\\Users\\fixture\\report 2026.txt')
  assert.equal(localChild('/home/fixture', 'name:with:colons', 'linux'), '/home/fixture/name:with:colons')
  assert.throws(() => localChild('/home/fixture', '../x', 'linux'), { code: 'EUNSAFE_NAME' })
})

test('saved changes to endpoint, protocol, TLS mode, identity or trust end the session', async () => {
  const context = await setup({ tls: 'explicit' })
  try {
    for (const change of [{ host: '127.0.0.1' }, { port: 1 }, { ftpTls: 'implicit' }, { username: 'other' }, { tlsTrustedCertificate: validPin }, { protocol: 'ftp' }, null]) {
      await context.ftp.connect(context.profile.id, PASSWORD)
      const events = context.events.length
      // A name or initial folder change keeps the session.
      context.ftp.invalidate([{ ...context.profile, name: 'Renamed', initialPath: '/x' }])
      assert.equal(context.ftp.status(context.profile.id), 'connected')
      context.ftp.invalidate(change ? [{ ...context.profile, ...change }] : [])
      assert.equal(context.ftp.status(context.profile.id), 'disconnected', JSON.stringify(change))
      assert.equal(context.events.at(-1).status, 'disconnected')
      assert.equal(context.events.length, events + 1)
    }
  } finally { await context.close() }
})

test('Socket.IO handlers return safe errors and the runtime reports all three protocols', async () => {
  const context = await setup({ tls: 'explicit', cert: pki.selfSigned })
  try {
    const handlers = new Map()
    registerConnectionHandlers({ on: (event, handler) => handlers.set(event, handler) }, { ftp: context.ftp })
    const call = (event, payload) => new Promise((resolve) => handlers.get(event)(payload, resolve))
    const failure = await call('ftp:connect', { profileId: context.profile.id, password: PASSWORD })
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'ETLS_CERTIFICATE_UNTRUSTED')
    assert.equal(failure.certificate.reason, 'untrusted')
    assert.equal(JSON.stringify(failure).includes(PASSWORD), false)
    context.profiles.set(context.profile.id, { ...context.profile, tlsTrustedCertificate: failure.certificate.sha256 })
    const connected = await call('ftp:connect', { profileId: context.profile.id, password: PASSWORD })
    assert.equal(connected.ok, true)
    assert.equal(connected.providerId, `ftps:${context.profile.id}`)
    assert.deepEqual(await call('ftp:status', { connectionId: context.profile.id }), { ok: true, status: 'connected' })
    assert.deepEqual((await call('connections:capabilities', {})).capabilities.protocols, ['sftp', 'ftp', 'ftps'])
    assert.equal((await call('connections:capabilities', {})).capabilities.credentialStore, false)
    await call('ftp:disconnect', { connectionId: context.profile.id })
    assert.deepEqual(await call('ftp:status', { connectionId: context.profile.id }), { ok: true, status: 'disconnected' })
    assert.equal(JSON.stringify(context.events).includes(PASSWORD), false)
  } finally { await context.close() }
})

test('no password appears in anything the backend printed', () => {
  assert.equal(printed.some((line) => line.includes(PASSWORD)), false)
})
