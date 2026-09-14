import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-filesystem-'))
process.env.FILE_MANAGER_ROOT = fixtureRoot

const { fileManagerRoot, getRootEntry, listDirectory } = await import(
  '../server/filesystem.js'
)

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

test('uses FILE_MANAGER_ROOT and returns root metadata', async () => {
  const root = await getRootEntry()

  assert.equal(fileManagerRoot, fixtureRoot)
  assert.equal(root.path, fixtureRoot)
  assert.equal(root.isDirectory, true)
  assert.equal(root.size, null)
  assert.match(root.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('sorts directories first and uses natural case-insensitive order', async () => {
  await Promise.all([
    fs.mkdir(path.join(fixtureRoot, 'folder10')),
    fs.mkdir(path.join(fixtureRoot, 'Folder2')),
    fs.writeFile(path.join(fixtureRoot, 'file10.txt'), 'ten bytes!'),
    fs.writeFile(path.join(fixtureRoot, 'File2.txt'), 'two'),
  ])

  const entries = await listDirectory(fixtureRoot)

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['Folder2', 'folder10', 'File2.txt', 'file10.txt'],
  )

  const folder = entries.find((entry) => entry.name === 'Folder2')
  const file = entries.find((entry) => entry.name === 'File2.txt')

  assert.equal(folder.size, null)
  assert.match(folder.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(file.size, 3)
  assert.match(file.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(file.metadataError, null)
})

test('rejects paths above FILE_MANAGER_ROOT', async () => {
  await assert.rejects(() => listDirectory(path.dirname(fixtureRoot)), {
    code: 'EOUTSIDE_ROOT',
  })
})
