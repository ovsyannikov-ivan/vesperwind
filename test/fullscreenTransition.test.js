import assert from 'node:assert/strict'
import test from 'node:test'
import { runFullscreenTransition } from '../src/player/fullscreenTransition.js'

test('fullscreen resize stays covered until presentation is ready', async () => {
  const calls = []
  let ready
  const pending = new Promise((resolve) => { ready = resolve })
  const transition = runFullscreenTransition({
    cover: async () => calls.push('cover'),
    change: async () => calls.push('resize'),
    settle: async () => { calls.push('wait'); await pending },
    reveal: async () => calls.push('reveal'),
  })
  await new Promise(setImmediate)
  assert.deepEqual(calls, ['cover', 'resize', 'wait'])
  ready()
  await transition
  assert.deepEqual(calls, ['cover', 'resize', 'wait', 'reveal'])
})

test('failed native fullscreen operation always removes the cover', async () => {
  let revealed = false
  await assert.rejects(runFullscreenTransition({
    cover: async () => {},
    change: async () => { throw new Error('native failure') },
    settle: async () => assert.fail('must not wait after failure'),
    reveal: async () => { revealed = true },
  }), /native failure/)
  assert.equal(revealed, true)
})

test('an unresponsive native resize still reveals and releases the transition', async () => {
  let revealed = false
  await assert.rejects(runFullscreenTransition({
    cover: async () => {},
    change: () => new Promise(() => {}),
    settle: async () => assert.fail('must not wait after timeout'),
    reveal: async () => { revealed = true },
    timeout: 20,
  }), /resize timed out/)
  assert.equal(revealed, true)
})

test('an unresponsive reveal cannot leave fullscreen actions locked forever', async () => {
  await assert.rejects(runFullscreenTransition({
    cover: async () => {},
    change: async () => {},
    settle: async () => {},
    reveal: () => new Promise(() => {}),
    timeout: 20,
  }), /reveal timed out/)
})
