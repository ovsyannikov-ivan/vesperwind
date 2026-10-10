// A small, controllable FTP/FTPS server for Node tests. It serves a
// directory over plain FTP, explicit FTPS (AUTH TLS) or implicit FTPS and can
// inject the failures a client must handle: rejected AUTH TLS or PROT P,
// required TLS session reuse on data connections, a final error after all
// bytes, stalled and throttled transfers, servers without MLSD, and hostile
// directory listings. Credentials are synthetic. Test-only.
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Synthetic PKI through the OpenSSL CLI: CA, leaf, wrong-host, expired, self-signed. */
export const createTestPki = async (directory) => {
  const openssl = process.env.VESPERWIND_OPENSSL || 'openssl'
  const exec = (args) => run(openssl, args, { cwd: directory, windowsHide: true })
  await fs.writeFile(path.join(directory, 'ca.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
  await exec(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30',
    '-subj', '/CN=Vesperwind Node Test CA/O=Vesperwind Test', '-config', 'ca.cnf', '-extensions', 'ca'])
  const leaf = async (name, san, extra = []) => {
    await fs.writeFile(path.join(directory, `${name}.cnf`), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`)
    await exec(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}/O=Vesperwind Test`])
    await exec(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-extfile', `${name}.cnf`, ...extra])
    return { cert: await fs.readFile(path.join(directory, `${name}.pem`), 'utf8'), key: await fs.readFile(path.join(directory, `${name}.key`), 'utf8') }
  }
  const ca = await fs.readFile(path.join(directory, 'ca.pem'), 'utf8')
  const valid = await leaf('localhost', 'DNS:localhost,IP:127.0.0.1', ['-days', '30'])
  const wrongHost = await leaf('other', 'DNS:other.invalid', ['-days', '30'])
  // Expired: valid for one day, starting 30 days ago (OpenSSL 3 `-not_before`/`-not_after`).
  const now = Date.now()
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  const expired = await leaf('expired', 'DNS:localhost,IP:127.0.0.1', ['-not_before', stamp(now - 30 * 86400000), '-not_after', stamp(now - 29 * 86400000)])
  await exec(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.pem', '-days', '30',
    '-subj', '/CN=localhost/O=Vesperwind Self-signed', '-config', 'ca.cnf', '-addext', 'basicConstraints=CA:FALSE',
    '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
  const selfSigned = { cert: await fs.readFile(path.join(directory, 'self.pem'), 'utf8'), key: await fs.readFile(path.join(directory, 'self.key'), 'utf8') }
  return { ca, valid, wrongHost, expired, selfSigned }
}

const timestamp = (date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14)

const mlsdLine = async (file, name) => {
  const stat = await fs.lstat(file)
  const modify = timestamp(stat.mtime)
  if (stat.isSymbolicLink()) return `type=OS.unix=slink:${await fs.readlink(file)};modify=${modify}; ${name}`
  if (stat.isDirectory()) return `type=dir;modify=${modify};perm=flcdmpe; ${name}`
  return `type=file;size=${stat.size};modify=${modify};perm=adfrw; ${name}`
}

const listLine = async (file, name, format) => {
  const stat = await fs.lstat(file)
  if (format === 'dos') return stat.isDirectory() ? `01-02-26  03:04PM       <DIR>          ${name}` : `01-02-26  03:04PM       ${String(stat.size).padStart(14)} ${name}`
  const kind = stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : '-'
  const target = stat.isSymbolicLink() ? ` -> ${await fs.readlink(file)}` : ''
  return `${kind}rw-r--r--    1 owner    group    ${String(stat.size).padStart(10)} Jan 02 15:04 ${name}${target}`
}

export const startFtpTestServer = async (root, options = {}) => {
  const settings = {
    tls: 'none', // none | explicit | implicit
    users: { fixture: 'fixture-password' }, allowAnonymous: true,
    rejectAuthTls: false, rejectProtP: false, requireSessionReuse: false,
    mlsd: true, listFormat: 'unix', storFinalError: null, retrFinalError: null,
    stallRetrAfter: null, throttle: 0, extraMlsd: [], extraList: [],
    ...options,
  }
  const secureContext = settings.cert ? tls.createSecureContext({ cert: settings.cert, key: settings.key }) : null
  // `dataCert`: data connections present another certificate (a separate
  // context, so the control session cannot be resumed), like an attacker
  // that took over the data port.
  const dataContext = settings.dataCert ? tls.createSecureContext(settings.dataCert) : secureContext
  const log = { commands: [], dataResumed: [], open: 0, peak: 0, accepted: 0, received: 0 }
  const sockets = new Set()
  const resolvePath = (argument) => {
    const parts = []
    for (const part of String(argument || '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..') return null
      parts.push(part)
    }
    return path.join(root, ...parts)
  }
  const handle = (raw) => {
    sockets.add(raw); raw.on('close', () => sockets.delete(raw))
    log.accepted++; log.open++; log.peak = Math.max(log.peak, log.open)
    raw.on('close', () => { log.open-- })
    raw.on('error', () => {})
    let control = settings.tls === 'implicit' ? new tls.TLSSocket(raw, { isServer: true, secureContext }) : raw, buffer = '', user = null, loggedIn = false, protectedData = false, passive = null, renameFrom = null, restOffset = 0, queue = Promise.resolve()
    const secured = () => control instanceof tls.TLSSocket
    const reply = (code, text) => control.writable && control.write(`${code} ${text}\r\n`)
    const attach = (socket) => {
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1)
          queue = queue.then(() => command(line)).catch(() => control.destroy())
        }
      })
      socket.on('error', () => {})
    }
    const openData = async () => {
      if (!passive) { reply(425, 'Use EPSV or PASV first'); return null }
      if (settings.tls !== 'none' && !protectedData) { reply(521, 'PROT P required'); return null }
      reply(150, 'Opening data connection')
      const { server: listener, connection } = passive; passive = null
      let socket = await connection
      listener.close()
      if (!protectedData) return socket
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: dataContext })
      try {
        await new Promise((resolve, reject) => { secure.once('secure', resolve); secure.once('error', reject); secure.once('close', () => reject(new Error('closed'))) })
      } catch { reply(425, 'TLS negotiation on the data connection failed'); return null }
      const resumed = secure.isSessionReused()
      log.dataResumed.push(resumed)
      if (settings.requireSessionReuse && !resumed) { secure.destroy(); reply(522, 'SSL connection failed: session reuse required'); return null }
      return secure
    }
    const pace = (bytes) => settings.throttle ? new Promise((r) => setTimeout(r, (bytes / settings.throttle) * 1000)) : null
    // Sends a Buffer, or a file from an offset in chunks (large files are never held in memory).
    const sendData = async (source, finalError) => {
      const data = await openData(); if (!data) return
      const chunk = settings.throttle ? Math.max(1, Math.floor(settings.throttle / 10)) : 256 * 1024
      const handle = Buffer.isBuffer(source) ? null : await fs.open(source.file, 'r')
      const total = handle ? (await handle.stat()).size - source.offset : source.length
      let sent = 0
      try {
        while (sent < total) {
          if (data.destroyed) return
          if (settings.stallRetrAfter != null && sent >= settings.stallRetrAfter) {
            await new Promise((resolve) => data.once('close', resolve)); return
          }
          const length = Math.min(chunk, total - sent)
          const part = handle ? (await handle.read(Buffer.alloc(length), 0, length, source.offset + sent)).buffer : source.subarray(sent, sent + length)
          if (!data.write(part)) await new Promise((resolve) => { data.once('drain', resolve); data.once('close', resolve) })
          sent += part.length; await pace(part.length)
        }
      } finally { await handle?.close() }
      await new Promise((resolve) => data.end(resolve))
      // The final reply follows the closed data connection, so a client has
      // received every byte before it reads a final error.
      if (finalError) await new Promise((resolve) => { if (data.destroyed) resolve(); else data.once('close', resolve) })
      if (finalError) reply(finalError, 'Transfer failed after sending data')
      else reply(226, 'Transfer complete')
    }
    const receiveData = async (file) => {
      const data = await openData(); if (!data) return
      const out = createWriteStream(file)
      const ok = await new Promise((resolve) => {
        data.on('data', async (part) => { log.received += part.length; if (!out.write(part)) { data.pause(); out.once('drain', () => data.resume()) } if (settings.throttle) { data.pause(); await pace(part.length); data.resume() } })
        data.once('end', () => resolve(true)); data.once('error', () => resolve(false)); data.once('close', () => resolve(false))
      })
      await new Promise((resolve) => out.end(resolve))
      if (!ok) return reply(426, 'Connection closed; transfer aborted')
      if (settings.storFinalError) reply(settings.storFinalError, 'Upload rejected after receiving data')
      else reply(226, 'Transfer complete')
    }
    const command = async (line) => {
      log.commands.push(line)
      const space = line.indexOf(' ')
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase()
      const argument = space < 0 ? '' : line.slice(space + 1)
      const tlsRequired = settings.tls !== 'none'
      switch (verb) {
        case 'AUTH':
          if (settings.tls === 'none' || settings.rejectAuthTls) return reply(502, 'AUTH not supported')
          reply(234, 'Proceed with negotiation')
          control.removeAllListeners('data')
          control = new tls.TLSSocket(raw, { isServer: true, secureContext })
          attach(control)
          return
        case 'USER':
          if (tlsRequired && !secured()) return reply(530, 'TLS required')
          user = argument; return reply(331, 'Password required')
        case 'PASS': {
          if (user == null) return reply(503, 'USER first')
          loggedIn = (user === 'anonymous' && settings.allowAnonymous) || settings.users[user] === argument
          return loggedIn ? reply(230, 'Logged in') : reply(530, 'Login incorrect')
        }
        case 'PBSZ': return reply(200, 'PBSZ=0')
        case 'PROT':
          if (argument.toUpperCase() === 'P') {
            if (settings.rejectProtP || !secured()) return reply(536, 'PROT P not available')
            protectedData = true; return reply(200, 'Protection set to Private')
          }
          if (tlsRequired) return reply(534, 'Clear data channel refused')
          protectedData = false; return reply(200, 'Protection set to Clear')
        case 'FEAT': {
          const features = ['UTF8', 'SIZE', 'MDTM', 'REST STREAM', 'EPSV', ...(settings.mlsd ? ['MLST type*;size*;modify*;perm*;'] : []), ...(tlsRequired ? ['AUTH TLS', 'PBSZ', 'PROT'] : [])]
          control.write(`211-Features\r\n${features.map((f) => ` ${f}\r\n`).join('')}211 End\r\n`); return
        }
        case 'OPTS': case 'TYPE': case 'MODE': case 'STRU': case 'NOOP': return reply(200, 'OK')
        case 'SYST': return reply(215, 'UNIX Type: L8')
        case 'QUIT': reply(221, 'Bye'); control.end(); return
      }
      if (!loggedIn) return reply(530, 'Not logged in')
      switch (verb) {
        case 'PWD': return reply(257, '"/" is the current directory')
        case 'CWD': {
          const target = resolvePath(argument)
          return target && (await fs.stat(target).catch(() => null))?.isDirectory() ? reply(250, 'OK') : reply(550, 'No such directory')
        }
        case 'EPSV': case 'PASV': {
          const listener = net.createServer()
          let accept
          const connection = new Promise((resolve) => { accept = resolve })
          listener.once('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); accept(socket) })
          await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
          passive = { server: listener, connection }
          const port = listener.address().port
          return verb === 'EPSV' ? reply(229, `Entering Extended Passive Mode (|||${port}|)`)
            : reply(227, `Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`)
        }
        case 'SIZE': {
          const stat = await fs.stat(resolvePath(argument) || '').catch(() => null)
          return stat?.isFile() ? reply(213, String(stat.size)) : reply(550, 'No such file')
        }
        case 'MDTM': {
          const stat = await fs.stat(resolvePath(argument) || '').catch(() => null)
          return stat?.isFile() ? reply(213, timestamp(stat.mtime)) : reply(550, 'No such file')
        }
        case 'MLST': {
          if (!settings.mlsd) return reply(500, 'Unknown command')
          const target = resolvePath(argument)
          if (!target || !(await fs.lstat(target).catch(() => null))) return reply(550, 'No such file')
          control.write(`250-Listing ${argument}\r\n ${await mlsdLine(target, argument)}\r\n250 End\r\n`); return
        }
        case 'MLSD': case 'LIST': case 'NLST': {
          if (verb === 'MLSD' && !settings.mlsd) return reply(500, 'Unknown command')
          // `LIST -a /dir`: options come first.
          const target = argument.startsWith('-') ? argument.replace(/^-\S*\s*/, '') : argument
          const directory = resolvePath(target || '/')
          if (!directory || !(await fs.stat(directory).catch(() => null))?.isDirectory()) return reply(550, 'No such directory')
          const names = (await fs.readdir(directory)).sort()
          const lines = []
          for (const name of names) {
            const file = path.join(directory, name)
            lines.push(verb === 'MLSD' ? await mlsdLine(file, name) : verb === 'NLST' ? name : await listLine(file, name, settings.listFormat))
          }
          if (verb === 'MLSD') lines.push(...settings.extraMlsd)
          if (verb === 'LIST') lines.push(...settings.extraList)
          return sendData(Buffer.from(lines.length ? `${lines.join('\r\n')}\r\n` : ''), null)
        }
        case 'RETR': {
          const target = resolvePath(argument)
          const stat = target && await fs.stat(target).catch(() => null)
          if (!stat?.isFile()) return reply(550, 'No such file')
          const offset = restOffset; restOffset = 0
          return sendData({ file: target, offset }, settings.retrFinalError)
        }
        case 'STOR': {
          const target = resolvePath(argument)
          return target ? receiveData(target) : reply(553, 'Bad name')
        }
        case 'DELE': {
          const target = resolvePath(argument)
          return target && (await fs.unlink(target).then(() => true, () => false)) ? reply(250, 'Deleted') : reply(550, 'Delete failed')
        }
        case 'RMD': {
          const target = resolvePath(argument)
          return target && (await fs.rmdir(target).then(() => true, () => false)) ? reply(250, 'Removed') : reply(550, 'Remove failed')
        }
        case 'MKD': {
          const target = resolvePath(argument)
          return target && (await fs.mkdir(target).then(() => true, () => false)) ? reply(257, `"${argument}" created`) : reply(550, 'Create failed')
        }
        case 'RNFR': {
          const target = resolvePath(argument)
          if (!target || !(await fs.lstat(target).catch(() => null))) return reply(550, 'No such file')
          renameFrom = target; return reply(350, 'Ready for RNTO')
        }
        case 'RNTO': {
          const target = resolvePath(argument), from = renameFrom; renameFrom = null
          return from && target && (await fs.rename(from, target).then(() => true, () => false)) ? reply(250, 'Renamed') : reply(550, 'Rename failed')
        }
        case 'REST':
          if (!/^\d+$/.test(argument)) return reply(501, 'Bad offset')
          restOffset = Number(argument); return reply(350, `Restarting at ${argument}`)
        case 'ABOR': return reply(226, 'Abort OK')
        default: return reply(502, 'Command not implemented')
      }
    }
    attach(control)
    reply(220, 'Vesperwind Node test FTP server')
  }
  // Implicit FTPS wraps the accepted socket with the same secure context as
  // the data connections, so data connections can resume the control session.
  const server = net.createServer(handle)
  await new Promise((resolve) => server.listen(settings.port || 0, '127.0.0.1', resolve))
  return {
    port: server.address().port, root, log,
    sent: (prefix) => log.commands.some((line) => line.startsWith(prefix)),
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }),
    waitClosed: async (ms = 5000) => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (log.open === 0) return true; await new Promise((r) => setTimeout(r, 10)) }
      return false
    },
  }
}
