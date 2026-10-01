import assert from 'node:assert/strict'
import test from 'node:test'
import { createSeekController, canHandleSeekKey } from '../src/player/seekController.js'

const harness = (time = 40, duration = 120) => {
  let timer
  let hint
  const seeks = []
  const errors = []
  const clock = { time, duration }
  const controller = createSeekController({
    getTime: () => clock.time, getDuration: () => clock.duration,
    seek: (target) => { seeks.push(target) }, onChange: (value) => { hint = value },
    onError: (error) => errors.push(error),
    setTimer: (callback, delay) => { assert.equal(delay, 180); timer = callback; return callback },
    clearTimer: (id) => { if (timer === id) timer = null },
  })
  return { clock, controller, seeks, errors, expire: () => timer?.(), get hint() { return hint } }
}

test('three quick presses update +30 immediately and issue one absolute seek from the original clock', () => {
  const h = harness()
  h.controller.add(10)
  assert.deepEqual(h.hint, { target: 50, delta: 10 })
  h.clock.time = 42
  h.controller.add(10)
  h.controller.add(10)
  assert.deepEqual(h.hint, { target: 70, delta: 30 })
  assert.deepEqual(h.seeks, [])
  h.expire()
  assert.deepEqual(h.seeks, [70])
  assert.equal(h.hint, null)
  h.clock.time = 70
  h.controller.add(-10)
  h.expire()
  assert.deepEqual(h.seeks, [70, 60])
})

test('clamps both ends, skips unchanged targets and reverses immediately after reaching an edge', () => {
  const h = harness(115)
  h.controller.add(10)
  h.controller.add(10)
  assert.deepEqual(h.hint, { target: 120, delta: 5 })
  h.controller.add(-10)
  assert.deepEqual(h.hint, { target: 110, delta: -5 })
  h.expire()
  assert.deepEqual(h.seeks, [110])
  h.clock.time = 5
  h.controller.add(-10)
  h.expire()
  assert.deepEqual(h.seeks, [110, 0])
  h.clock.time = 0
  h.controller.add(-10)
  h.expire()
  assert.deepEqual(h.seeks, [110, 0])
})

test('mixed keys cancel, lifecycle reset cancels the series and duration is checked at commit', () => {
  const h = harness()
  h.controller.add(10)
  h.controller.add(-10)
  h.expire()
  assert.deepEqual(h.seeks, [])
  h.controller.add(10)
  h.controller.reset()
  h.expire()
  assert.deepEqual(h.seeks, [])
  assert.equal(h.hint, null)
  h.controller.add(10)
  h.clock.duration = 45
  h.expire()
  assert.deepEqual(h.seeks, [45])
  h.clock.duration = 0
  assert.equal(h.controller.add(10), false)
})

test('failed seeks clear accumulated state and allow the next series', async () => {
  let hint
  let error
  const controller = createSeekController({ getTime: () => 10, getDuration: () => 60,
    seek: () => Promise.reject(new Error('unavailable')), onChange: (v) => { hint = v }, onError: (v) => { error = v } })
  controller.add(10)
  controller.flush()
  await Promise.resolve()
  assert.equal(hint, null)
  assert.equal(error.message, 'unavailable')
  controller.add(-10)
  assert.equal(hint.target, 0)
  controller.reset()
})

test('seek shortcuts respect editable fields, sliders, menus, modifiers and handled events', () => {
  const event = { key: 'ArrowRight', composedPath: () => [] }
  assert.equal(canHandleSeekKey(event), true)
  for (const field of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'defaultPrevented']) {
    assert.equal(canHandleSeekKey({ ...event, [field]: true }), false)
  }
  assert.equal(canHandleSeekKey({ ...event, composedPath: () => [{ matches: () => true }] }), false)
  assert.equal(canHandleSeekKey({ ...event, key: ' ' }), false)
})
