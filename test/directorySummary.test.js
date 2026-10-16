import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeDirectory, formatDirectorySize } from '../src/utils/directorySummary.js'
import { sortAndFilterEntries } from '../src/utils/fileDirectoryView.js'

test('summarizes only immediate listing entries, ignoring folder sizes and contents', () => {
  const folder = { name: 'Nested', isDirectory: true, size: 999999,
    get children() { throw new Error('Must not traverse folders') } }
  const summary = summarizeDirectory([folder,
    { name: 'a.bin', size: 24_000_000 }, { name: 'b.bin', size: 500_000 }, { name: 'empty', size: 0 }])
  assert.deepEqual(summary, { folders: 1, files: 3, bytes: 24_500_000, unknownSizes: 0 })
  assert.match(formatDirectorySize(summary), /^24[.,]5 MB$/)
  assert.equal(formatDirectorySize(summarizeDirectory([])), '0 B')
})

test('unknown metadata does not become zero or corrupt the known total', () => {
  const entries = [null, undefined, -1, NaN, Infinity].map(size => ({ size }))
  assert.equal(formatDirectorySize(summarizeDirectory(entries)), '—')
  const summary = summarizeDirectory([...entries, { size: 1000 }])
  assert.deepEqual(summary, { folders: 0, files: 6, bytes: 1000, unknownSizes: 5 })
  assert.equal(formatDirectorySize(summary), '≥ 1 KB')
})

test('filtered totals follow the displayed current folder entries', () => {
  const entries = [{ name: 'Folder', isDirectory: true }, { name: 'a.txt', size: 100 }, { name: 'b.png', size: 200 }]
  const shown = sortAndFilterEntries(entries, { extensions: ['.txt'], keepFolders: false })
  assert.deepEqual(summarizeDirectory(shown), { folders: 0, files: 1, bytes: 100, unknownSizes: 0 })
})
