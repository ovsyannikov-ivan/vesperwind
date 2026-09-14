import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatFileSize,
  formatModifiedAt,
  formatModifiedAtTitle,
} from '../src/utils/fileMetadata.js'

test('formats file sizes with decimal units', () => {
  assert.equal(formatFileSize(0), '0 B')
  assert.equal(formatFileSize(586_000), '586 KB')
  assert.match(formatFileSize(1_900_000), /^1[.,]9 MB$/)
  assert.equal(formatFileSize(null), '—')
  assert.equal(formatFileSize(42, true), '—')
})

test('formats valid dates and falls back for missing metadata', () => {
  const value = '2026-09-10T12:31:39.000Z'

  assert.match(formatModifiedAt(value), /2026/)
  assert.ok(formatModifiedAtTitle(value).length > 0)
  assert.equal(formatModifiedAt(null), '—')
  assert.equal(formatModifiedAt('not-a-date'), '—')
  assert.equal(formatModifiedAtTitle('not-a-date'), '')
})

test('uses a fixed numeric date format independent of browser locale', () => {
  const value = new Date(2026, 2, 18, 10, 32)

  assert.equal(formatModifiedAt(value), '18.03.2026 10:32')
  assert.equal(formatModifiedAtTitle(value), '18.03.2026 10:32')
})

test('uses the selected Intl locale when one is configured', () => {
  const value = new Date(2026, 2, 18, 10, 32)
  const expected = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)

  assert.equal(formatModifiedAt(value, 'en-GB'), expected)
  assert.equal(formatModifiedAtTitle(value, 'en-GB'), expected)
})
