import assert from 'node:assert/strict'
import test from 'node:test'
import { createLayoutQueue } from '../src/player/layoutQueue.js'

test('native resize backlog retains only the last layout and skips duplicates', async () => {
  const calls = []
  let finishFirst
  const queue = createLayoutQueue({ apply: async (value) => {
    calls.push(value)
    if (calls.length === 1) await new Promise((resolve) => { finishFirst = resolve })
  } })
  const first = queue.request({ width: 640 })
  await Promise.resolve()
  for (let width = 650; width <= 1000; width += 10) queue.request({ width })
  assert.deepEqual(calls, [{ width: 640 }])
  finishFirst()
  await first
  assert.deepEqual(calls, [{ width: 640 }, { width: 1000 }])
  await queue.request({ width: 1000 })
  assert.equal(calls.length, 2)
})

test('fullscreen cancels queued resize requests and failed layouts remain retryable', async () => {
  let finishFirst
  const calls = []
  const errors = []
  const queue = createLayoutQueue({ apply: async (value) => {
    calls.push(value)
    if (calls.length === 1) await new Promise((resolve) => { finishFirst = resolve })
    if (value === 'fail') throw new Error('resize failed')
  }, onError: (error) => errors.push(error.message) })
  const first = queue.request('modal')
  await Promise.resolve()
  queue.request('obsolete')
  queue.cancel()
  finishFirst()
  await queue.flush()
  await first
  assert.deepEqual(calls, ['modal'])
  await queue.request('fail')
  await queue.request('fail')
  assert.deepEqual(errors, ['resize failed', 'resize failed'])
  await queue.request('fullscreen')
  assert.equal(calls.at(-1), 'fullscreen')
})
