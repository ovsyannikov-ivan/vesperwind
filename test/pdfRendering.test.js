import assert from 'node:assert/strict'
import test from 'node:test'
import { calculatePdfOutputScale } from '../src/utils/pdfRendering.js'

test('caps PDF canvas output scale by device pixel ratio', () => {
  assert.equal(
    calculatePdfOutputScale({ width: 800, height: 600 }, 2, 16_000_000, 3),
    2,
  )
})

test('reduces PDF canvas output scale to stay inside the pixel budget', () => {
  const outputScale = calculatePdfOutputScale(
    { width: 4000, height: 4000 },
    2,
    4_000_000,
    2,
  )

  assert.equal(outputScale, 0.5)
  assert.equal(4000 * 4000 * outputScale ** 2, 4_000_000)
})

test('keeps unusually large PDF pages inside the pixel budget', () => {
  const outputScale = calculatePdfOutputScale(
    { width: 100_000, height: 100_000 },
    2,
    16_000_000,
    2,
  )

  assert.equal(outputScale, 0.04)
  assert.equal(100_000 * 100_000 * outputScale ** 2, 16_000_000)
})
