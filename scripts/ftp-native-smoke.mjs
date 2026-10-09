// Opt-in native FTP/FTPS acceptance against the debug Vesperwind executable.
// The app starts local FTP, explicit FTPS and implicit FTPS servers itself;
// this script prepares a synthetic CA (OpenSSL is a test-preparation tool
// only), free ports and a loopback SFTP server for FTP <-> SFTP transfers.
// Credentials are synthetic; saved test passwords are removed at the end.
//
//   VESPERWIND_NATIVE_BINARY=/abs/path/to/debug/vesperwind \
//     node scripts/ftp-native-smoke.mjs /new/output/directory [--long]
//
// `--long` throttles one download so it runs longer than the two-minute
// inactivity limit while staying active.
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import ssh2 from 'ssh2'

const output = process.argv[2] && path.resolve(process.argv[2])
if (!output) throw Error('Provide a new output directory')
const long = process.argv.includes('--long')
await fs.mkdir(output) // Never overwrite an existing acceptance run.
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.resolve(`src-tauri/target/debug/vesperwind${process.platform === 'win32' ? '.exe' : ''}`)
const openssl = process.env.VESPERWIND_OPENSSL || 'openssl'
const run = (file, args) => promisify(execFile)(file, args, { cwd: output, windowsHide: true })
const id = `qa-${randomUUID()}`

// Synthetic PKI: a CA, a leaf for localhost/127.0.0.1, and a self-signed leaf.
await fs.writeFile(path.join(output, 'leaf.cnf'), [
  'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '',
].join('\n'))
await fs.writeFile(path.join(output, 'ca.cnf'), [
  '[req]', 'distinguished_name=dn', '[dn]', '[ca]', 'basicConstraints=critical,CA:TRUE',
  'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', '',
].join('\n'))
await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30',
  '-subj', '/CN=Vesperwind FTP Test CA/O=Vesperwind Test', '-config', 'ca.cnf', '-extensions', 'ca'])
await run(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost/O=Vesperwind Test'])
await run(openssl, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf-only.pem', '-days', '30', '-extfile', 'leaf.cnf'])
await fs.writeFile(path.join(output, 'leaf.pem'), (await fs.readFile(path.join(output, 'leaf-only.pem'), 'utf8')) + await fs.readFile(path.join(output, 'ca.pem'), 'utf8'))
await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.pem', '-days', '30',
  '-subj', '/CN=localhost/O=Vesperwind Self-signed', '-config', 'ca.cnf', '-addext', 'basicConstraints=CA:FALSE',
  '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address(); probe.close(() => resolve(port))
  })
})
const ports = {}
for (const name of ['plain', 'explicit', 'implicit', 'selfsigned', 'reject', 'slow']) ports[name] = await freePort()

// A loopback SFTP server over a real directory (synthetic password only).
const sftpRoot = path.join(output, 'sftp-root')
await fs.mkdir(sftpRoot)
const local = (name) => {
  const resolved = path.join(sftpRoot, path.posix.normalize(`/${name}`))
  if (!resolved.startsWith(sftpRoot)) throw Error('outside')
  return resolved
}
const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
const parsedHost = ssh2.utils.parseKey(hostKey.public)
const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp
const attrs = (stat) => ({ mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) })
const sftpServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (context) => context.method === 'password' && context.username === 'fixture'
    && context.password === 'vesper-ftp-sftp-password' ? context.accept() : context.reject(['password']))
  client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (accept) => {
    const sftp = accept(), handles = new Map(); let sequence = 0
    const fail = (request, error) => sftp.status(request, error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)
    const handle = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(++sequence); handles.set(sequence, value); return buffer }
    const get = (buffer) => handles.get(buffer.readUInt32BE(0))
    sftp.on('error', () => {})
    sftp.on('REALPATH', (request, name) => sftp.name(request, [{ filename: path.posix.normalize(name === '.' ? '/' : `/${name}`), longname: '', attrs: {} }]))
    for (const event of ['STAT', 'LSTAT']) sftp.on(event, async (request, name) => {
      try { sftp.attrs(request, attrs(await (event === 'STAT' ? fs.stat : fs.lstat)(local(name)))) } catch (error) { fail(request, error) }
    })
    sftp.on('FSTAT', async (request, buffer) => { try { sftp.attrs(request, attrs(await get(buffer).file.stat())) } catch (error) { fail(request, error) } })
    sftp.on('OPEN', async (request, name, flags) => {
      try {
        const mode = (flags & OPEN_MODE.WRITE) ? ((flags & OPEN_MODE.EXCL) ? 'wx' : 'w') : 'r'
        sftp.handle(request, handle({ file: await fs.open(local(name), mode) }))
      } catch (error) { fail(request, error) }
    })
    sftp.on('READ', async (request, buffer, offset, length) => {
      try {
        const data = Buffer.alloc(length); const { bytesRead } = await get(buffer).file.read(data, 0, length, offset)
        bytesRead ? sftp.data(request, data.subarray(0, bytesRead)) : sftp.status(request, STATUS_CODE.EOF)
      } catch (error) { fail(request, error) }
    })
    sftp.on('WRITE', async (request, buffer, offset, data) => {
      try { await get(buffer).file.write(data, 0, data.length, offset); sftp.status(request, STATUS_CODE.OK) } catch (error) { fail(request, error) }
    })
    sftp.on('OPENDIR', async (request, name) => {
      try { const names = await fs.readdir(local(name)); sftp.handle(request, handle({ directory: local(name), names, done: false })) } catch (error) { fail(request, error) }
    })
    sftp.on('READDIR', async (request, buffer) => {
      const state = get(buffer)
      if (!state || state.done) return sftp.status(request, STATUS_CODE.EOF)
      state.done = true
      const entries = await Promise.all(state.names.map(async (filename) => ({ filename, longname: filename, attrs: attrs(await fs.lstat(path.join(state.directory, filename))) })))
      entries.length ? sftp.name(request, entries) : sftp.status(request, STATUS_CODE.EOF)
    })
    sftp.on('CLOSE', async (request, buffer) => { const state = get(buffer); handles.delete(buffer.readUInt32BE(0)); await state?.file?.close(); sftp.status(request, STATUS_CODE.OK) })
    sftp.on('MKDIR', async (request, name) => { try { await fs.mkdir(local(name)); sftp.status(request, STATUS_CODE.OK) } catch (error) { fail(request, error) } })
    sftp.on('RMDIR', async (request, name) => { try { await fs.rmdir(local(name)); sftp.status(request, STATUS_CODE.OK) } catch (error) { fail(request, error) } })
    sftp.on('REMOVE', async (request, name) => { try { await fs.unlink(local(name)); sftp.status(request, STATUS_CODE.OK) } catch (error) { fail(request, error) } })
    sftp.on('RENAME', async (request, from, to) => { try { await fs.rename(local(from), local(to)); sftp.status(request, STATUS_CODE.OK) } catch (error) { fail(request, error) } })
    sftp.on('SETSTAT', (request) => sftp.status(request, STATUS_CODE.OK))
  })))
})
await new Promise((resolve, reject) => { sftpServer.once('error', reject); sftpServer.listen(0, '127.0.0.1', resolve) })
const sftpFingerprint = `SHA256:${createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, '')}`

await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify({
  id, ports, long, throttle: long ? 150_000 : 4_000_000, size: 24 * 1024 * 1024,
  ca: path.join(output, 'ca.pem'), leaf: path.join(output, 'leaf.pem'), key: path.join(output, 'leaf.key'),
  selfLeaf: path.join(output, 'self.pem'), selfKey: path.join(output, 'self.key'),
  sftp: { port: sftpServer.address().port, fingerprint: sftpFingerprint, password: 'vesper-ftp-sftp-password', root: sftpRoot },
}))

const env = { ...process.env, VESPERWIND_SETTINGS_PATH: path.join(output, 'settings.json'), VESPERWIND_FTP_TEST_CA: path.join(output, 'ca.pem') }
if (process.platform === 'win32') {
  env.APPDATA = path.join(output, 'appdata'); env.LOCALAPPDATA = path.join(output, 'localappdata')
  await fs.mkdir(env.APPDATA); await fs.mkdir(env.LOCALAPPDATA)
}
const phase = async (name, limit) => {
  const log = await fs.open(path.join(output, `${name}.log`), 'w')
  const child = spawn(binary, ['--ftp-regression', output, name], { env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
  const timer = setTimeout(() => child.kill('SIGTERM'), limit)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer); await log.close()
  const receipt = JSON.parse(await fs.readFile(path.join(output, `${name}.json`), 'utf8').catch(() => '{}'))
  if (code !== 0 || !receipt.ok) throw Error(`${name} failed: ${receipt.error || code}`)
  console.log(JSON.stringify({ phase: name, events: receipt.events }))
}
try {
  await phase('seed', long ? 600_000 : 180_000)
  await phase('restart', 60_000)
} finally {
  await phase('cleanup', 60_000).catch((error) => { console.error(error.message); process.exitCode = 1 })
  sftpServer.close()
}
// The written settings never contain a password.
const settings = await fs.readFile(path.join(output, 'settings.json'), 'utf8')
if (/fixture-password|vesper-ftp-sftp-password/.test(settings)) throw Error('A password was written to settings')
console.log(JSON.stringify({ ok: true, output }))
