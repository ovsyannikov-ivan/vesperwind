// Opt-in real app/OS-store acceptance. All credentials and keys are synthetic;
// ~/.ssh/config is never modified. Windows uses the existing service, adding
// and finally removing only this run's synthetic identities; production auth uses libssh2 APIs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import ssh2 from 'ssh2'

const output = process.argv[2] && path.resolve(process.argv[2])
if (!output) throw Error('Provide a new output directory')
await fs.mkdir(output) // Never overwrite an existing acceptance run.
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.resolve(`src-tauri/target/debug/vesperwind${process.platform === 'win32' ? '.exe' : ''}`)
const execute = (file, args, options = {}) => promisify(execFile)(file, args, { windowsHide: true, ...options })
const id = `qa-${randomUUID()}`
const keys = () => ssh2.utils.generateKeyPairSync('ed25519')
const host = keys(), bad = keys(), good = keys(), fileKey = keys()
const encrypted = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'vesper-fixture-passphrase', cipher: 'aes256-cbc' })
const parsed = value => { const key = ssh2.utils.parseKey(value); return Array.isArray(key) ? key[0] : key }
const allowed = [parsed(good.public), parsed(fileKey.public), parsed(encrypted.public)]
let rejectedAgentBlob = parsed(bad.public).getPublicSSH()
for (const [name, key] of [['bad-key', bad], ['good-key', good], ['config-key', fileKey], ['encrypted-key', encrypted]]) {
  await fs.writeFile(path.join(output, name), key.private, { mode: 0o600 })
  await fs.writeFile(path.join(output, `${name}.pub`), key.public)
}
const clients = new Set(), stats = { password: 0, publickey: 0, accepted: 0, rejectedAgentKey: 0, shells: 0, sftp: {}, connections: [] }
const fileContent = Buffer.from('controlled remote fixture\n')
const directory = { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 1, mtime: 1 }
const file = { mode: 0o100644, uid: 0, gid: 0, size: fileContent.length, atime: 1, mtime: 1 }
const server = new ssh2.Server({ hostKeys: [host.private] }, client => {
  const trace = { authAttempts: 0, accepted: false }; stats.connections.push(trace)
  clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', error => { trace.handshakeError = error.message })
  client.on('authentication', context => {
    trace.authAttempts++
    if (context.username !== 'fixture') return context.reject(['password', 'publickey'])
    let accepted = false
    if (context.method === 'password') { stats.password++; accepted = context.password === 'vesper-fixture-password' }
    if (context.method === 'publickey') {
      stats.publickey++
      const key = allowed.find(key => key.getPublicSSH().equals(context.key.data))
      if (!key && rejectedAgentBlob.equals(context.key.data)) stats.rejectedAgentKey++
      accepted = Boolean(key && (!context.signature || key.verify(context.blob, context.signature, context.hashAlgo) === true))
    }
    if (accepted) { stats.accepted++; trace.accepted = true; context.accept() } else context.reject(['password', 'publickey'])
  })
  client.on('ready', () => client.on('session', accept => {
    const session = accept()
    session.on('pty', accept => accept())
    session.on('shell', accept => { stats.shells++; const channel = accept(); channel.write('Controlled SSH terminal\r\n'); channel.on('error', () => {}) })
    session.on('sftp', accept => {
      const sftp = accept(), handles = new Map(); let sequence = 0
      for (const name of ['STAT','LSTAT','FSTAT','REALPATH','OPEN','OPENDIR','READ','READDIR','CLOSE']) sftp.on(name, () => { stats.sftp[name] = (stats.sftp[name] || 0) + 1 })
      const status = (request, code = ssh2.utils.sftp.STATUS_CODE.OK) => sftp.status(request, code)
      const attributes = name => name === '/fixture.txt' ? file : directory
      for (const event of ['STAT', 'LSTAT']) sftp.on(event, (request, name) => sftp.attrs(request, attributes(name)))
      sftp.on('FSTAT', (request, handle) => sftp.attrs(request, handles.get(handle.readUInt32BE(0))?.type === 'file' ? file : directory))
      sftp.on('REALPATH', (request, name) => sftp.name(request, [{ filename: name === '.' ? '/' : name, longname: name, attrs: attributes(name) }]))
      for (const event of ['OPEN', 'OPENDIR']) sftp.on(event, (request, name) => {
        const handle = Buffer.alloc(4); handle.writeUInt32BE(++sequence); handles.set(sequence, { type: event === 'OPEN' ? 'file' : 'directory', read: false }); sftp.handle(request, handle)
      })
      sftp.on('READ', (request, _handle, offset, length) => offset >= fileContent.length
        ? status(request, ssh2.utils.sftp.STATUS_CODE.EOF) : sftp.data(request, fileContent.subarray(offset, offset + length)))
      sftp.on('READDIR', (request, handle) => {
        const state = handles.get(handle.readUInt32BE(0))
        if (!state || state.read) return status(request, ssh2.utils.sftp.STATUS_CODE.EOF)
        state.read = true; sftp.name(request, [{ filename: 'fixture.txt', longname: 'fixture.txt', attrs: file }])
      })
      sftp.on('CLOSE', (request, handle) => { handles.delete(handle.readUInt32BE(0)); status(request) })
      sftp.on('error', () => {})
    })
  }))
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const fingerprint = `SHA256:${createHash('sha256').update(parsed(host.public).getPublicSSH()).digest('base64').replace(/=+$/, '')}`
await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify({ id, port, fingerprint }))
const config = path.join(output, 'ssh-config')
await fs.writeFile(config, `Host vesperwind-fixture\n HostName 127.0.0.1\n User fixture\n Port ${port}\n IdentityFile "${path.join(output, 'config-key').replaceAll('\\', '/')}"\n IdentitiesOnly yes\n`)
const socket = path.join(output, 'agent.sock')
let agent, agentBefore, windowsKeysAttempted = false
const sshAdd = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh-add.exe' : '/usr/bin/ssh-add'
const agentIdentities = async () => {
  try {
    const { stdout } = await execute(sshAdd, ['-L'])
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => createHash('sha256').update(line.split(/\s+/)[1]).digest('hex')).sort()
  } catch (error) {
    if (error.code === 1 && /no identities/i.test(String(error.stdout) + String(error.stderr))) return []
    throw error
  }
}
const until = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw Error('Agent fixture did not start') }
try {
  const env = { ...process.env, VESPERWIND_SETTINGS_PATH: path.join(output, 'settings.json'), VESPERWIND_SSH_CONFIG_FIXTURE: config }
  if (process.platform === 'win32') {
    agentBefore = await agentIdentities()
    if (process.env.VESPERWIND_AGENT_PIPE_EXPLICIT === '1') env.SSH_AUTH_SOCK = String.raw`\\.\pipe\openssh-ssh-agent`
    else delete env.SSH_AUTH_SOCK // Exercise libssh2's native named-pipe fallback.
    env.APPDATA = path.join(output, 'appdata'); env.LOCALAPPDATA = path.join(output, 'localappdata')
    await fs.mkdir(env.APPDATA); await fs.mkdir(env.LOCALAPPDATA)
    const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
    const sid = stdout.match(/S-1-5-\d+(?:-\d+)+/)[0]
    for (const name of ['bad-key', 'good-key']) {
      await execute('icacls.exe', [path.join(output, name), '/inheritance:r', '/grant:r', `*${sid}:(F)`])
    }
    windowsKeysAttempted = true
  } else {
    agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' })
    await until(async () => fs.stat(socket).then(() => true, () => false))
    env.SSH_AUTH_SOCK = socket
  }
  await execute(sshAdd, [path.join(output, 'bad-key'), path.join(output, 'good-key')], { env })
  if (process.platform === 'win32') {
    const after = await agentIdentities()
    if (after.length !== agentBefore.length + 2 || !agentBefore.every(key => after.includes(key))) throw Error('Synthetic agent setup did not preserve prior identities')
    // Windows service enumeration order differs from ssh-add insertion order.
    // Accept the last synthetic identity in the actual agent list so the first
    // synthetic identity must be rejected before authentication can succeed.
    const { stdout } = await execute(sshAdd, ['-L'], { env })
    const synthetic = [ ['bad-key', bad], ['good-key', good] ].map(([name, key]) => ({ name, key: parsed(key.public), blob: key.public.trim().split(/\s+/)[1] }))
    const ordered = stdout.trim().split(/\r?\n/).map(line => synthetic.find(key => key.blob === line.split(/\s+/)[1])).filter(Boolean)
    if (ordered.length !== 2) throw Error('Unable to determine synthetic Windows agent ordering')
    allowed[0] = ordered[1].key
    rejectedAgentBlob = ordered[0].key.getPublicSSH()
    await fs.writeFile(path.join(output, 'agent-setup.json'), JSON.stringify({ baselineCount: agentBefore.length, setupCount: after.length, priorIdentitiesPreserved: true, pipe: 'openssh-ssh-agent', explicitSocket: Boolean(env.SSH_AUTH_SOCK), acceptedSynthetic: ordered[1].name, rejectedSynthetic: ordered[0].name, acceptLastSynthetic: true }))
  }
  for (const phase of ['seed', 'restart', 'forgotten', 'reconcile']) {
    const logPath = path.join(output, `${phase}.log`), log = await fs.open(logPath, 'w')
    const child = spawn(binary, ['--remote-auth-regression', output, phase], { env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    clearTimeout(timer); await log.close()
    const receipt = JSON.parse(await fs.readFile(path.join(output, `${phase}.json`), 'utf8'))
    if (code !== 0 || !receipt.ok) throw Error(`${phase} failed: ${receipt.error || code}`)
    if (phase === 'seed' && (stats.connections.length < 4 || stats.connections.slice(0, 2).some(trace => trace.authAttempts !== 0))) throw Error('Untrusted host attempted authentication')
    console.log(JSON.stringify({ phase, events: receipt.events }))
  }
  if (!stats.rejectedAgentKey || stats.shells < 2) throw Error('Agent identity iteration or SSH terminal was not exercised')
  await fs.writeFile(path.join(output, 'server-stats.json'), JSON.stringify(stats))
  console.log(JSON.stringify({ ok: true, stats, output }))
} finally {
  await fs.writeFile(path.join(output, 'server-stats.json'), JSON.stringify(stats))
  // Purge only the UUID-scoped synthetic entries, including a failed run.
  const log = await fs.open(path.join(output, 'cleanup.log'), 'w')
  const cleanup = spawn(binary, ['--remote-auth-regression', output, 'cleanup'], {
    env: { ...process.env, APPDATA: path.join(output, 'appdata'), LOCALAPPDATA: path.join(output, 'localappdata'), VESPERWIND_SETTINGS_PATH: path.join(output, 'settings.json'), VESPERWIND_SSH_CONFIG_FIXTURE: config },
    windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  })
  const timer = setTimeout(() => cleanup.kill('SIGTERM'), 15_000)
  await new Promise(resolve => { cleanup.once('error', resolve); cleanup.once('exit', resolve) })
  clearTimeout(timer); await log.close()
  const cleanupReceipt = await fs.readFile(path.join(output, 'cleanup.json'), 'utf8').then(JSON.parse, () => null)
  if (!cleanupReceipt?.ok) process.exitCode = 1
  if (windowsKeysAttempted) {
    const failures = []
    for (const name of ['bad-key', 'good-key']) {
      try { await execute(sshAdd, ['-d', path.join(output, `${name}.pub`)]) } catch (error) { failures.push({ key: name, code: error.code }) }
    }
    const after = await agentIdentities()
    const preserved = JSON.stringify(after) === JSON.stringify(agentBefore)
    await fs.writeFile(path.join(output, 'agent-cleanup.json'), JSON.stringify({ baselineCount: agentBefore.length, finalCount: after.length, baselineRestored: preserved, failures }))
    if (!preserved || failures.length) process.exitCode = 1
  }
  agent?.kill('SIGTERM')
  for (const client of clients) client.end()
  server.close()
}
