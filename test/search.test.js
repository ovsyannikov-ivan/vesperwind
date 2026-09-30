import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-search-'))
process.env.FILE_MANAGER_ROOT = root
const { searchLocal, searchRemote, searchMatches } = await import('../server/search.js')
test.after(() => fs.rm(root, { recursive: true, force: true }))

const collect = async (options) => {
  const batches = []
  const outcome = await searchLocal({ basePath: root, query: '*.txt', onBatch: (items) => batches.push(items), ...options })
  return { entries: batches.flat(), batches, outcome }
}

test('recursive local search handles names, relative paths, Unicode, spaces, and type selectors', async () => {
  await fs.mkdir(path.join(root, 'nested folder'))
  await fs.writeFile(path.join(root, 'nested folder', 'Привет.txt'), 'hello')
  await fs.writeFile(path.join(root, 'App.vue'), '')
  const txt = await collect({})
  assert.equal(txt.entries.length, 1)
  assert.equal(txt.entries[0].relativePath, path.join('nested folder', 'Привет.txt'))
  assert.equal(searchMatches('App.vue', 'src/App.vue', '*.vue'), true)
  assert.equal(searchMatches('App.vue', 'src/App.vue', 'src/*'), true)
  const folders = await collect({ query: 'nested', type: 'folders' })
  assert.equal(folders.entries[0].name, 'nested folder')
  const files = await collect({ query: 'nested', type: 'files' })
  assert.equal(files.entries[0].name, 'Привет.txt')
})

test('local search batches, limits, cancels, and refuses paths outside root', async () => {
  const many = path.join(root, 'many')
  await fs.mkdir(many)
  await Promise.all(Array.from({ length: 80 }, (_, index) => fs.writeFile(path.join(many, `match-${index}.txt`), '')))
  const limited = await collect({ query: 'match', maxResults: 30 })
  assert.equal(limited.entries.length, 30)
  assert.equal(limited.outcome.limited, true)
  assert.ok(limited.batches.length >= 2)
  const controller = new AbortController()
  const cancelled = await collect({ query: 'match', signal: controller.signal,
    onBatch: () => controller.abort() })
  assert.equal(cancelled.outcome.cancelled, true)
  await assert.rejects(() => searchLocal({ basePath: path.dirname(root), query: 'x', onBatch: () => {} }),
    { code: 'EOUTSIDE_ROOT' })
})

test('local search never descends through a symlink escape and skips inaccessible folders', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-outside-'))
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), '')
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const found = await collect({ query: 'secret' })
    assert.equal(found.entries.length, 0)
  } finally { await fs.rm(outside, { recursive: true, force: true }) }
})

test('SFTP search uses serial provider listing, supports cancellation and permission failures', async () => {
  let concurrent = 0; let maximum = 0
  const connection = {
    resolve: (requested) => requested,
    list: async (requested) => {
      concurrent++; maximum = Math.max(maximum, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      concurrent--
      if (requested === '/remote/denied') { const error = new Error('denied'); error.code = 'EACCES'; throw error }
      return requested === '/remote' ? [
        { name: 'denied', path: '/remote/denied', isDirectory: true },
        { name: 'nested', path: '/remote/nested', isDirectory: true },
      ] : [{ name: 'App.vue', path: '/remote/nested/App.vue', isDirectory: false }]
    },
  }
  const batches = []
  const result = await searchRemote({ connection, basePath: '/remote', query: '*.vue', onBatch: (batch) => batches.push(batch) })
  assert.equal(result.count, 1)
  assert.equal(batches.flat()[0].relativePath, 'nested/App.vue')
  assert.equal(maximum, 1)
})
