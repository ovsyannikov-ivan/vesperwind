import assert from 'node:assert/strict'
import test from 'node:test'
import { selectFileEntries, transferSources } from '../src/utils/fileSelection.js'

const entry = (name, isDirectory = false, providerId = 'local') => ({
  providerId, path: `/work/${name}`, name, isDirectory,
})
const visibleEntries = [entry('alpha', true), entry('beta'), entry('gamma', true), entry('delta')]

test('plain, Shift, and Cmd/Ctrl clicks select visible files and folders', () => {
  const first = selectFileEntries({ entries: [], anchorPath: '', clicked: visibleEntries[0], visibleEntries })
  assert.deepEqual(first.entries.map(({ name }) => name), ['alpha'])
  const range = selectFileEntries({ ...first, clicked: visibleEntries[2], visibleEntries, shiftKey: true })
  assert.deepEqual(range.entries.map(({ name }) => name), ['alpha', 'beta', 'gamma'])
  assert.equal(range.anchorPath, visibleEntries[0].path)
  const removed = selectFileEntries({ ...range, clicked: visibleEntries[1], visibleEntries, additiveKey: true })
  assert.deepEqual(removed.entries.map(({ name }) => name), ['alpha', 'gamma'])
  const added = selectFileEntries({ ...removed, clicked: visibleEntries[3], visibleEntries, additiveKey: true })
  assert.deepEqual(added.entries.map(({ name }) => name), ['alpha', 'gamma', 'delta'])
  const plain = selectFileEntries({ ...added, clicked: visibleEntries[1], visibleEntries })
  assert.deepEqual(plain.entries.map(({ name }) => name), ['beta'])
})

test('selected folders subsume descendants during file transfers', () => {
  assert.deepEqual(
    transferSources([entry('folder/child'), entry('folder', true), entry('other')]).map(({ name }) => name),
    ['folder', 'other'],
  )
  assert.equal(transferSources([entry('a'), entry('a')]).length, 1)
})
