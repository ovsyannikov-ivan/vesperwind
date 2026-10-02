import assert from 'node:assert/strict'
import test from 'node:test'
import { createProgressDrag, progressTimeAtPointer } from '../src/player/progressRange.js'

test('random track clicks commit pointer position even if DOM value is stale and capture is lost', () => {
  const commits = []; const previews = []; let value = null; let captures = 0
  const drag = createProgressDrag({ getDuration: () => 7200, preview: (t) => previews.push(t), onDrag() {}, onCommit: (t) => commits.push(t), onChange: (t) => { value = t } })
  const event = (x) => ({ pointerId: 7, clientX: x, preventDefault() {}, currentTarget: { value: 0, setPointerCapture() { captures++ }, getBoundingClientRect: () => ({ left: 100, width: 1016 }) } })
  drag.start(event(858)); assert.equal(value, 5400); assert.equal(captures, 1)
  drag.end(event(858)); drag.cancel(); assert.deepEqual(commits, [5400]); assert.equal(value, null)
  drag.start(event(608)); drag.update(event(358)); assert.equal(value, 1800)
  drag.end(event(358)); assert.deepEqual(commits, [5400, 1800]); assert.ok(previews.length >= 3)
})
test('pointer cancellation cannot seek and endpoints clamp to duration', () => {
  assert.deepEqual(progressTimeAtPointer(-10, { left: 0, width: 100 }, 60), { time: 0, ratio: 0 })
  assert.deepEqual(progressTimeAtPointer(200, { left: 0, width: 100 }, 60), { time: 60, ratio: 1 })
  let commits = 0
  const drag = createProgressDrag({ getDuration: () => 60, preview() {}, onDrag() {}, onCommit() { commits++ }, onChange() {} })
  const e = { pointerId: 1, clientX: 40, preventDefault() {}, currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, width: 100 }) } }
  drag.start(e); drag.cancel(); drag.end(e); assert.equal(commits, 0)
})
