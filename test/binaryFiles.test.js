import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-binary-'))
process.env.FILE_MANAGER_ROOT = root
const { readBinaryFile, writeBinaryFile } = await import('../server/binaryFiles.js')
test.after(async () => fs.rm(root, { recursive: true, force: true }))

test('binary LocalProvider reads and writes arbitrary bytes at Unicode paths', async () => {
  const file = path.join(root, 'Отчёт workbook.xlsx')
  const original = Buffer.from([0, 255, 0, 128, 42])
  await fs.writeFile(file, original)
  assert.deepEqual(Buffer.from((await readBinaryFile(file)).base64, 'base64'), original)
  const changed = Buffer.from([37, 0, 214, 1])
  await writeBinaryFile(file, changed.toString('base64'))
  assert.deepEqual(await fs.readFile(file), changed)
})

test('binary LocalProvider rejects root escape, symlink escape, malformed payload and oversized file', async () => {
  const outside = path.join(os.tmpdir(), 'outside.xlsx')
  await assert.rejects(() => readBinaryFile(outside), { code: 'EOUTSIDE_ROOT' })
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-outside-binary-'))
  const target = path.join(outsideDirectory, 'outside.xlsx')
  await fs.writeFile(target, 'outside')
  // Directory junctions exercise realpath escapes without symlink privileges on Windows.
  const directoryLink = path.join(root, 'outside-link')
  await fs.symlink(outsideDirectory, directoryLink, process.platform === 'win32' ? 'junction' : 'dir')
  const link = path.join(directoryLink, 'outside.xlsx')
  await assert.rejects(() => readBinaryFile(link), { code: 'EOUTSIDE_ROOT' })
  await assert.rejects(() => writeBinaryFile(link, '!!!!'), { code: 'EINVAL' })
  const large = path.join(root, 'large.xlsx')
  await fs.writeFile(large, '')
  await fs.truncate(large, 32 * 1024 * 1024 + 1)
  await assert.rejects(() => readBinaryFile(large), { code: 'EFILE_TOO_LARGE' })
  await fs.rm(directoryLink, { recursive: true, force: true })
  await fs.rm(outsideDirectory, { recursive: true, force: true })
})

test('Socket binary handlers route SFTP paths through the same events as LocalProvider', async () => {
  const { registerBinaryFileHandlers } = await import('../server/binaryFiles.js')
  const handlers = new Map()
  const calls = []
  const connection = {
    readBinary: async (path) => { calls.push(['read', path]); return { base64: 'AAE=' } },
    writeBinary: async (path, value) => { calls.push(['write', path, value]); return { modifiedAt: 'now' } },
  }
  registerBinaryFileHandlers({ on: (event, callback) => handlers.set(event, callback) }, {
    ssh: { ensure: async (id) => { assert.equal(id, 'sftp:demo'); return connection }, get: (id) => { assert.equal(id, 'sftp:demo'); return connection } },
  })
  const read = await new Promise((resolve) => handlers.get('filesystem:read-binary')({ filesystemId: 'sftp:demo', path: '/папка/book.xlsx' }, resolve))
  const write = await new Promise((resolve) => handlers.get('filesystem:write-binary')({ filesystemId: 'sftp:demo', path: '/папка/book.xlsx', base64: read.base64 }, resolve))
  assert.equal(read.ok, true)
  assert.equal(write.ok, true)
  assert.deepEqual(calls, [['read', '/папка/book.xlsx'], ['write', '/папка/book.xlsx', 'AAE=']])
})
