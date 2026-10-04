import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-text-files-'))
process.env.FILE_MANAGER_ROOT = fixtureRoot

const { readTextFile, writeTextFile, registerTextFileHandlers } = await import('../server/textFiles.js')

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

test('reads and writes UTF-8 text through the filesystem adapter', async () => {
  const filePath = path.join(fixtureRoot, 'hello.txt')
  await fs.writeFile(filePath, 'before', 'utf8')

  const initial = await readTextFile(filePath, 'local')
  assert.equal(initial.content, 'before')

  await writeTextFile(filePath, 'после', 'local')
  assert.equal((await readTextFile(filePath, 'local')).content, 'после')
})

test('rejects reads outside FILE_MANAGER_ROOT and unknown filesystem adapters', async () => {
  await assert.rejects(() => readTextFile(path.dirname(fixtureRoot), 'local'), {
    code: 'EOUTSIDE_ROOT',
  })
  await assert.rejects(() => readTextFile(fixtureRoot, 'remote'), {
    code: 'EFILESYSTEM_ID',
  })
})


test('Quick Look reads enforce the requested bound and strict text decoding', async () => {
  const filePath = path.join(fixtureRoot, 'preview.txt')
  await fs.writeFile(filePath, 'hello\n\tworld')
  assert.equal((await readTextFile(filePath, 'local', { maxBytes: 12, strictText: true })).content, 'hello\n\tworld')
  await assert.rejects(readTextFile(filePath, 'local', { maxBytes: 4, strictText: true }), { code: 'EFILE_TOO_LARGE' })
  await fs.writeFile(filePath, Buffer.from([0, 255]))
  await assert.rejects(readTextFile(filePath, 'local', { maxBytes: 4, strictText: true }), { code: 'ETEXT_BINARY' })
})

test('remote text preview forwards the same read bound and decoding policy through SFTP', async () => {
  const handlers = new Map()
  const calls = []
  registerTextFileHandlers({ on: (event, handler) => handlers.set(event, handler) }, { ssh: {
    ensure: async (provider) => ({ readText: async (path, options) => {
      calls.push({ provider, path, options })
      return { content: 'remote text', modifiedAt: 'now' }
    } }),
  } })
  let result
  await handlers.get('filesystem:read-text')({ filesystemId: 'sftp:demo', path: '/remote/code.ts', maxBytes: 3 * 1024 * 1024, strictText: true }, (response) => { result = response })
  assert.deepEqual(calls, [{ provider: 'sftp:demo', path: '/remote/code.ts', options: { maxBytes: 3 * 1024 * 1024, strictText: true } }])
  assert.equal(result.content, 'remote text')
})
