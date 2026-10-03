import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeChapters, currentChapterIndex, adjacentChapterIndex, formatChapterTime } from '../src/player/chapters.js'

test('common chapters reject invalid metadata and preserve titles and stable indices', () => {
  const chapters = normalizeChapters([
    { index: 2, startTime: 20, title: '' },
    { index: 0, startTime: 0, title: '日本語 — Вступление' },
    { index: 1, startTime: 10, title: null },
    { index: 3, startTime: NaN }, { index: 4, startTime: -1 },
  ])
  assert.deepEqual(chapters.map((c) => c.title), ['日本語 — Вступление', 'Chapter 2', 'Chapter 3'])
  assert.equal(currentChapterIndex(chapters, 9.999), 0)
  assert.equal(currentChapterIndex(chapters, 10), 1)
  assert.equal(currentChapterIndex(chapters, 17.375), 1)
  assert.equal(currentChapterIndex(chapters, 20), 2)
  assert.equal(currentChapterIndex([], 20), null)
  assert.equal(adjacentChapterIndex(chapters, 0, -1), null)
  assert.equal(adjacentChapterIndex(chapters, 2, 1), null)
  assert.equal(adjacentChapterIndex(chapters, null, 1), 0)
  assert.equal(formatChapterTime(16638), '04:37:18')
  assert.equal(formatChapterTime(0), '00:00:00')
})
