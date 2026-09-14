import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterVisibleFilesystemEntries,
  isVisibleFilesystemEntry,
} from '../src/utils/fileVisibility.js'

test('hides files and folders whose names end with .localized', () => {
  const hiddenNameSuffixes = ['.localized']
  const entries = [
    { name: '.localized', isDirectory: false },
    { name: 'Media.localized', isDirectory: true },
    { name: 'ARCHIVE.LOCALIZED', isDirectory: true },
    { name: 'localized', isDirectory: false },
    { name: 'notes.localized.txt', isDirectory: false },
  ]

  assert.deepEqual(
    filterVisibleFilesystemEntries(entries, hiddenNameSuffixes).map(
      (entry) => entry.name,
    ),
    ['localized', 'notes.localized.txt'],
  )
})

test('applies the same visibility rule to files and folders', () => {
  const hiddenNameSuffixes = ['.localized']

  assert.equal(
    isVisibleFilesystemEntry(
      { name: '.localized', isDirectory: false },
      hiddenNameSuffixes,
    ),
    false,
  )
  assert.equal(
    isVisibleFilesystemEntry(
      { name: 'Media.localized', isDirectory: true },
      hiddenNameSuffixes,
    ),
    false,
  )
  assert.equal(
    isVisibleFilesystemEntry(
      { name: 'Media', isDirectory: true },
      hiddenNameSuffixes,
    ),
    true,
  )
})
