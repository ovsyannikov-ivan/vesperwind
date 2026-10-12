import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { findExistingAncestor, isMissingDirectoryError } from '../src/utils/missingDirectory.js'
import { createDirectoryListing } from '../src/utils/directoryListing.js'

test('only a folder that is gone counts as missing', () => {
  for (const code of ['ENOENT', 'ENOTDIR', 2]) assert.equal(isMissingDirectoryError({ code }), true, String(code))
  for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT', 'EALIAS_INSPECT', undefined]) assert.equal(isMissingDirectoryError({ code }), false, String(code))
  assert.equal(isMissingDirectoryError(null), false)
})

test('the panel climbs one level at a time to the nearest folder that still exists', async () => {
  const checked = []
  const existing = new Set(['/Users/ivan/Library'])
  const exists = async (path) => { checked.push(path); return existing.has(path) }
  assert.equal(await findExistingAncestor({ rootPath: '/', path: '/Users/ivan/Library/Caches/samples/images', exists }), '/Users/ivan/Library')
  assert.deepEqual(checked, ['/Users/ivan/Library/Caches/samples', '/Users/ivan/Library/Caches', '/Users/ivan/Library'])

  checked.length = 0
  assert.equal(await findExistingAncestor({ rootPath: '/', path: '/gone/deeper', exists }), '/')
  assert.deepEqual(checked, ['/gone'])
  assert.equal(await findExistingAncestor({ rootPath: '/home/user', path: '/home/user/a', exists: async () => false }), '/home/user')
  assert.equal(await findExistingAncestor({ rootPath: 'C:\\', path: 'C:\\Docs\\Old', exists: async (path) => path === 'C:\\Docs' }), 'C:\\Docs')
})

test('a failed listing reports its location and error to the owner', async () => {
  const failures = []
  const state = { loaded: false, children: [], error: null, loading: false, sourceEntryCount: 0 }
  const listing = createDirectoryListing({ state, getLocation: () => ({ providerId: 'local', path: '/gone' }),
    list: async () => ({ ok: false, error: { code: 'ENOENT', message: 'Folder no longer exists' } }),
    onFailed: (payload) => failures.push(payload) })
  assert.equal(await listing.load(), false)
  assert.deepEqual(failures, [{ providerId: 'local', path: '/gone', error: { code: 'ENOENT', message: 'Folder no longer exists' } }])
  listing.dispose()

  const thrown = []
  const throwing = createDirectoryListing({ state: { ...state }, getLocation: () => ({ providerId: 'sftp:x', path: '/r' }),
    list: async () => { throw Object.assign(new Error('No such file'), { code: 2 }) }, onFailed: (payload) => thrown.push(payload) })
  await throwing.load()
  assert.equal(thrown[0].error.code, 2)
  throwing.dispose()
})

test('the open folder of a panel, not an expanded subfolder, triggers the climb', async () => {
  const tree = await fs.readFile(new URL('../src/composables/useDirectoryTree.js', import.meta.url), 'utf8')
  assert.match(tree, /onFailed: \(payload\) => onListingFailed\(\{ \.\.\.payload, depth \}\)/)
  const fileTree = await fs.readFile(new URL('../src/components/FileTree.vue', import.meta.url), 'utf8')
  assert.match(fileTree, /onListingFailed: \(payload\) => emit\('listing-failed', payload\)/)
  const panel = await fs.readFile(new URL('../src/components/FilePanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /@listing-failed="leaveMissingDirectory"/)
  assert.match(panel, /depth !== 0 \|\| providerId !== props\.providerId \|\| path !== root\.value\?\.path \|\| !isMissingDirectoryError\(error\)/)
  assert.match(panel, /filesystem\.resolveLocation\(\{ providerId, path: candidate \}\)/)
})
