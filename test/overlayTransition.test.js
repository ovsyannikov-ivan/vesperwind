import assert from 'node:assert/strict'
import test from 'node:test'
import { createOverlayTransitionHandler } from '../src/player/overlayTransition.js'

const harness = (paint = async () => {}) => {
  let timer
  let resets = 0
  const acknowledgements = []
  const handler = createOverlayTransitionHandler({
    paint,
    reset: () => { resets += 1 },
    acknowledge: (id, error) => acknowledgements.push({ id, error }),
    setTimer: (callback) => { timer = callback; return callback },
    clearTimer: (id) => { if (id === timer) timer = undefined },
  })
  return {
    handler, acknowledgements,
    expire: () => timer?.(),
    get resets() { return resets },
    get armed() { return Boolean(timer) },
  }
}

test('a stalled native transition cannot leave an acknowledged cover blocking input', async () => {
  const check = harness()
  await check.handler.handle({ id: 'cover', covered: true })
  assert.deepEqual(check.acknowledgements, [{ id: 'cover', error: undefined }])
  assert.equal(check.armed, true)
  check.expire()
  assert.equal(check.resets, 1)
  assert.equal(check.armed, false)
})

test('a suspended paint is acknowledged as failed and uncovered by the watchdog', async () => {
  let finish
  const check = harness(() => new Promise((resolve) => { finish = resolve }))
  const pending = check.handler.handle({ id: 'cover', covered: true })
  check.expire()
  assert.equal(check.resets, 1)
  assert.match(check.acknowledgements[0].error, /timed out/)
  finish()
  await pending
  assert.equal(check.acknowledgements.length, 1)
  assert.equal(check.armed, false)
})

test('failed paint immediately restores the controls and reports the error', async () => {
  const check = harness(async () => { throw new Error('resize failed') })
  await check.handler.handle({ id: 'cover', covered: true })
  assert.equal(check.resets, 1)
  assert.deepEqual(check.acknowledgements, [{ id: 'cover', error: 'resize failed' }])
  assert.equal(check.armed, false)
})

test('an old paint cannot acknowledge or reset a newer transition', async () => {
  let finish
  const check = harness(({ id }) => id === 'old'
    ? new Promise((resolve) => { finish = resolve }) : Promise.resolve())
  const old = check.handler.handle({ id: 'old', covered: true })
  await check.handler.handle({ id: 'new', covered: false })
  finish()
  await old
  assert.deepEqual(check.acknowledgements, [
    { id: 'old', error: 'Media transition was superseded' },
    { id: 'new', error: undefined },
  ])
  assert.equal(check.resets, 0)
  assert.equal(check.armed, false)
})

test('successful reveal cancels the watchdog without touching later controls', async () => {
  const check = harness()
  await check.handler.handle({ id: 'cover', covered: true })
  await check.handler.handle({ id: 'reveal', covered: false })
  check.expire()
  assert.equal(check.resets, 0)
  assert.equal(check.armed, false)
})
