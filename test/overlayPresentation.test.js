import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForOverlayPresentation } from '../src/player/overlayPresentation.js'

test('a modal-sized overlay cannot acknowledge a fullscreen cover', async () => {
  const sizes = [
    { width: 900, height: 600 },
    { width: 1920, height: 600 },
    { width: 1920, height: 1080 },
    { width: 900, height: 600 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1080 },
  ]
  let index = -1
  await waitForOverlayPresentation({
    viewport: { width: 1920, height: 1080 },
    frame: async () => { index += 1 },
    measure: () => sizes[index],
    now: () => index * 16,
  })
  assert.equal(index, 5)
})

test('even an immediate cover waits for two presentation frames', async () => {
  let frames = 0
  await waitForOverlayPresentation({
    viewport: null,
    frame: async () => { frames += 1 },
    measure: () => ({ width: 100, height: 100 }),
    now: () => frames * 16,
  })
  assert.equal(frames, 2)
})

test('a failed overlay resize cannot acknowledge a complete cover', async () => {
  let frames = 0
  await assert.rejects(waitForOverlayPresentation({
    viewport: { width: 1920, height: 1080 },
    frame: async () => { frames += 1 },
    measure: () => ({ width: 900, height: 600 }),
    now: () => frames * 100,
    timeout: 250,
  }), /did not present/)
})
