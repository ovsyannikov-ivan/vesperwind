import assert from 'node:assert/strict'
import test from 'node:test'
import { createSeekController } from '../src/player/seekController.js'
import { createSeekFeedbackDisplay } from '../src/player/seekFeedbackDisplay.js'

test('completed seek hint holds for 1.2s while pending progress clears at 180ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hint, pending
  const seeks = []
  const display = createSeekFeedbackDisplay({
    onChange: (value) => {
      hint = value
    },
  })
  const controller = createSeekController({
    getTime: () => 40,
    getDuration: () => 200,
    seek: (target) => seeks.push(target),
    onChange: (value, detail) => {
      pending = value
      display.update(value, detail)
    },
  })
  controller.add(10)
  controller.add(10)
  controller.add(10)
  assert.equal(hint.delta, 30)
  t.mock.timers.tick(180)
  assert.equal(pending, null)
  assert.deepEqual(seeks, [70])
  assert.equal(hint.delta, 30)
  t.mock.timers.tick(1199)
  assert.equal(hint.delta, 30)
  t.mock.timers.tick(1)
  assert.equal(hint, null)
})

test('new burst replaces hint and resets hide deadline; reset cancels stale callbacks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hint
  const display = createSeekFeedbackDisplay({
    onChange: (value) => {
      hint = value
    },
  })
  display.update({ delta: 10, target: 50 })
  display.update(null, { committed: true })
  t.mock.timers.tick(1000)
  display.update({ delta: -20, target: 20 })
  t.mock.timers.tick(500)
  assert.equal(hint.delta, -20)
  display.update(null, { committed: true })
  t.mock.timers.tick(1000)
  assert.equal(hint.delta, -20)
  display.reset()
  t.mock.timers.tick(500)
  assert.equal(hint, null)
  display.update({ delta: 10, target: 50 })
  display.update(null) // Lifecycle reset, unlike a committed seek.
  assert.equal(hint, null)
})
