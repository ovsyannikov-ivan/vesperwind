import assert from 'node:assert/strict'
import test from 'node:test'
import { availableExtensions, nameMatches, sortAndFilterEntries } from '../src/utils/fileDirectoryView.js'
import { reconcileFilteredSelection } from '../src/utils/reconcileFilteredSelection.js'

const entry = (name, size = 0, modifiedAt = '2026-01-01T00:00:00Z', isDirectory = false) =>
  ({ name, path: `/work/${name}`, size, modifiedAt, isDirectory })
const entries = [entry('folder', 0, '2026-01-03T00:00:00Z', true), entry('Test.txt', 3),
  entry('team.txt', 1), entry('photo.JPG', 7, '2026-01-04T00:00:00Z'), entry('README', 2)]

test('name filtering supports substring and escaped wildcard syntax without evaluating regex', () => {
  assert.equal(nameMatches('Test.txt', 'test'), true)
  assert.equal(nameMatches('Test.txt', '*.txt'), true)
  assert.equal(nameMatches('Test.txt', 'te*.txt'), true)
  assert.equal(nameMatches('report-12.pdf', 'report-??.pdf'), true)
  assert.equal(nameMatches('report-123.pdf', 'report-??.pdf'), false)
  assert.equal(nameMatches('a[b].txt', 'a[b].txt'), true)
})

test('extension filtering supports multiple values and extensionless files while retaining folders', () => {
  assert.deepEqual(availableExtensions(entries), ['', '.jpg', '.txt'])
  const names = sortAndFilterEntries(entries, { extensions: ['.jpg', '.txt'] }).map((item) => item.name)
  assert.deepEqual(names, ['folder', 'photo.JPG', 'team.txt', 'Test.txt'])
  assert.deepEqual(sortAndFilterEntries(entries, { extensions: [''] }).map((item) => item.name), ['folder', 'README'])
  assert.deepEqual(sortAndFilterEntries(entries, { name: '*.txt' }).map((item) => item.name), ['team.txt', 'Test.txt'])
})

test('sorts name, size and date in both directions with folders first', () => {
  assert.deepEqual(sortAndFilterEntries(entries, { sort: 'name', direction: 'desc' }).map((item) => item.name),
    ['folder', 'Test.txt', 'team.txt', 'README', 'photo.JPG'])
  assert.deepEqual(sortAndFilterEntries(entries, { sort: 'size', direction: 'asc' }).map((item) => item.name),
    ['folder', 'team.txt', 'README', 'Test.txt', 'photo.JPG'])
  assert.equal(sortAndFilterEntries(entries, { sort: 'date', direction: 'desc' })[1].name, 'photo.JPG')
})

test('hidden selection and Shift anchor are removed when a filter hides entries', () => {
  const selectedEntries = [entries[1], entries[2], entries[3]]
  const next = reconcileFilteredSelection({ selectedEntries, anchorPath: entries[1].path }, entries,
    { name: '*.jpg' })
  assert.deepEqual(next.selectedEntries.map((item) => item.name), ['photo.JPG'])
  assert.equal(next.anchorPath, entries[3].path)
})
