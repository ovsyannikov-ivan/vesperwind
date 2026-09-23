import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculatePdfOutputScale,
  getPdfCssPageSize,
  setPdfTextLayerViewport,
} from '../src/utils/pdfRendering.js'

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

test('configures PDF.js text geometry from the page viewport at every zoom', () => {
  const properties = new Map()
  const container = {
    style: {
      setProperty: (name, value) => properties.set(name, String(value)),
    },
  }

  for (const scale of [0.7, 1, 1.5, 2]) {
    // A non-default user unit also changes PDF.js viewport dimensions.
    setPdfTextLayerViewport(container, { scale, userUnit: 2, rotation: 90 })
    assert.equal(properties.get('--scale-factor'), String(scale))
    assert.equal(properties.get('--user-unit'), '2')
    assert.equal(
      properties.get('--total-scale-factor'),
      'calc(var(--scale-factor) * var(--user-unit))',
    )
    assert.equal(properties.get('--scale-round-x'), '1px')
    assert.equal(properties.get('--scale-round-y'), '1px')
  }

  // DPR changes bitmap resolution, not the viewport's CSS coordinate system.
  assert.equal(properties.has('--output-scale'), false)
})

test('rounds the PDF page and canvas to the text layer CSS dimensions', () => {
  assert.deepEqual(getPdfCssPageSize({ width: 612 * 0.7, height: 792 * 0.7 }), {
    width: 428,
    height: 554,
  })
  assert.deepEqual(getPdfCssPageSize({ width: 612 * 2, height: 792 * 2 }), {
    width: 1224,
    height: 1584,
  })
})
