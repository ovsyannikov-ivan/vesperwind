// A minimal SFTP server (ssh2) serving one directory, for transfers between
// SFTP and other providers in Node tests. Password authentication with
// synthetic credentials; the host key fingerprint is returned for trust.
// Test-only.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ssh2 from 'ssh2'

const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp

const attributes = (stat) => ({
  mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size,
  atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000),
})

const longname = (name, stat) => `${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : '-'}rw-r--r-- 1 owner group ${stat.size} Jan 01 00:00 ${name}`

export const startSftpTestServer = async (root, { username = 'fixture', password = 'fixture-password', extraNames = [] } = {}) => {
  const keys = ssh2.utils.generateKeyPairSync('ed25519')
  const key = ssh2.utils.parseKey(keys.public)
  const fingerprint = `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  const clients = new Set()
  const local = (remote) => {
    const parts = []
    for (const part of String(remote).split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return path.join(root, ...parts)
  }
  const server = new ssh2.Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === username && context.password === password) context.accept()
      else context.reject(['password'])
    })
    client.on('session', (acceptSession) => {
      const session = acceptSession()
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        const handles = new Map()
        let nextHandle = 0
        const handleOf = (buffer) => handles.get(buffer.readUInt32BE(0))
        const newHandle = (value) => { const id = nextHandle++; handles.set(id, value); const buffer = Buffer.alloc(4); buffer.writeUInt32BE(id); return buffer }
        const fail = (id, error) => sftp.status(id, error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : error?.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE)
        const guard = (id, operation) => Promise.resolve().then(operation).catch((error) => fail(id, error))
        sftp.on('OPEN', (id, filename, flags) => guard(id, async () => {
          let mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.READ ? 'r+' : 'w') : 'r'
          if (flags & OPEN_MODE.EXCL) mode = 'wx'
          else if (flags & OPEN_MODE.APPEND) mode = 'a'
          const file = await fs.open(local(filename), mode)
          sftp.handle(id, newHandle({ file }))
        }))
        sftp.on('READ', (id, handle, offset, length) => guard(id, async () => {
          const { file } = handleOf(handle)
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await file.read(buffer, 0, length, Number(offset))
          if (!bytesRead) sftp.status(id, STATUS_CODE.EOF)
          else sftp.data(id, buffer.subarray(0, bytesRead))
        }))
        sftp.on('WRITE', (id, handle, offset, data) => guard(id, async () => {
          await handleOf(handle).file.write(data, 0, data.length, Number(offset))
          sftp.status(id, STATUS_CODE.OK)
        }))
        sftp.on('FSTAT', (id, handle) => guard(id, async () => sftp.attrs(id, attributes(await handleOf(handle).file.stat()))))
        sftp.on('CLOSE', (id, handle) => guard(id, async () => {
          const entry = handleOf(handle)
          handles.delete(handle.readUInt32BE(0))
          await entry?.file?.close()
          sftp.status(id, STATUS_CODE.OK)
        }))
        sftp.on('OPENDIR', (id, directory) => guard(id, async () => {
          const names = await fs.readdir(local(directory))
          sftp.handle(id, newHandle({ directory: local(directory), names: [...names, ...extraNames], done: false }))
        }))
        sftp.on('READDIR', (id, handle) => guard(id, async () => {
          const entry = handleOf(handle)
          if (entry.done) return sftp.status(id, STATUS_CODE.EOF)
          entry.done = true
          const items = []
          for (const name of entry.names) {
            const stat = await fs.lstat(path.join(entry.directory, name)).catch(() => null)
            const fake = { mode: 0o100644, size: 1, isDirectory: () => false, isSymbolicLink: () => false, uid: 0, gid: 0, atimeMs: 0, mtimeMs: 0 }
            items.push({ filename: name, longname: longname(name, stat || fake), attrs: attributes(stat || fake) })
          }
          sftp.name(id, items)
        }))
        for (const event of ['STAT', 'LSTAT']) {
          sftp.on(event, (id, file) => guard(id, async () => sftp.attrs(id, attributes(await (event === 'STAT' ? fs.stat : fs.lstat)(local(file))))))
        }
        sftp.on('REALPATH', (id, value) => {
          const normalized = path.posix.normalize(`/${value === '.' ? '' : value}`)
          sftp.name(id, [{ filename: normalized, longname: normalized, attrs: {} }])
        })
        sftp.on('MKDIR', (id, directory) => guard(id, async () => { await fs.mkdir(local(directory)); sftp.status(id, STATUS_CODE.OK) }))
        sftp.on('RMDIR', (id, directory) => guard(id, async () => { await fs.rmdir(local(directory)); sftp.status(id, STATUS_CODE.OK) }))
        sftp.on('REMOVE', (id, file) => guard(id, async () => { await fs.unlink(local(file)); sftp.status(id, STATUS_CODE.OK) }))
        sftp.on('RENAME', (id, from, to) => guard(id, async () => { await fs.rename(local(from), local(to)); sftp.status(id, STATUS_CODE.OK) }))
        sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
        sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    fingerprint,
    close: () => new Promise((resolve) => { for (const client of clients) client.end(); server.close(() => resolve()) }),
  }
}
