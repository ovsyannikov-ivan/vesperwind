import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForNativeGeometry } from '../src/player/nativeGeometry.js'

test('owned VO waits past hidden Bootstrap layout and moving modal geometry', async () => {
  const layouts = [
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 20, y: 20, width: 640, height: 360, scaleFactor: 2 },
    { x: 20, y: 40, width: 640, height: 360, scaleFactor: 2 },
    { x: 20, y: 40, width: 640, height: 360, scaleFactor: 2 },
  ]
  let count = 0
  const bounds = await waitForNativeGeometry({ measure: () => layouts[count++],
    frame: async () => {}, now: () => 0 })
  assert.equal(count, 4)
  assert.deepEqual(bounds, layouts[3])
})

test('closing before a visible viewport cancels startup', async () => {
  let closed = false
  const bounds = await waitForNativeGeometry({ measure: () => assert.fail('measured after close'),
    frame: async () => { closed = true }, cancelled: () => closed, now: () => 0 })
  assert.equal(bounds, null)
})

test('an indefinitely hidden viewport produces a bounded diagnostic error', async () => {
  let clock = 0
  await assert.rejects(waitForNativeGeometry({ measure: () => ({ width: 0, height: 0 }),
    frame: async () => { clock += 100 }, now: () => clock, timeout: 200 }), /viewport/)
})

test('a suspended WKWebView animation frame cannot hold startup indefinitely', async () => {
  await assert.rejects(waitForNativeGeometry({ measure: () => assert.fail('suspended frame'),
    frame: () => new Promise(() => {}), timeout: 20 }), /viewport/)
})
