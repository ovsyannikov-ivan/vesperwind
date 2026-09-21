import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildPdfTextMatchSegments } from '../src/utils/pdfTextSearch.js'

test('maps PDF matches onto one text-layer item', () => {
  const segments = buildPdfTextMatchSegments(
    ['Hello PDF'],
    [6],
    [3],
    0,
  )

  assert.deepEqual(segments[0], [
    { text: 'Hello ', matchIndex: -1, selected: false, position: '' },
    { text: 'PDF', matchIndex: 0, selected: true, position: 'single' },
  ])
})

test('maps phrase matches across multiple PDF text-layer items', () => {
  const segments = buildPdfTextMatchSegments(
    ['remote ', 'document', ' search'],
    [3],
    [19],
    0,
  )

  assert.deepEqual(
    segments.map((items) => items.filter((item) => item.matchIndex === 0).map((item) => item.position)),
    [['begin'], ['middle'], ['end']],
  )
})

test('PDF viewer keeps URL/range loading and uses PDF.js text/find primitives', async () => {
  const source = await readFile(
    new URL('../src/components/PdfViewer.vue', import.meta.url),
    'utf8',
  )

  assert.match(source, /new TextLayer\(/u)
  assert.match(source, /new PDFFindController\(/u)
  assert.match(source, /url: sourceUrl\.value/u)
  assert.match(source, /rangeChunkSize: 64 \* 1024/u)
  assert.doesNotMatch(source, /arrayBuffer\s*\(/u)
})
