import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-text-files-'))
process.env.FILE_MANAGER_ROOT = fixtureRoot

const { readTextFile, writeTextFile } = await import('../server/textFiles.js')

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
