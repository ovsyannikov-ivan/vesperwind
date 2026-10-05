import assert from 'node:assert/strict'
import test from 'node:test'
import { createControlsVisibility, CONTROLS_HIDE_MS } from '../src/player/controlsVisibility.js'

const harness = () => {
  let now = 0, id = 0
  const timers = new Map()
  const state = { visible: true, pointerInsideControls: false }
  const playback = { playing: true, menu: '', error: null, transitioning: false }
  const controls = createControlsVisibility({ state, getPlayback: () => playback,
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id },
    clearTimer: (key) => timers.delete(key) })
  return { ...controls, state, playback, timers, advance(ms) {
    now += ms
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn() }
  } }
}
test('stationary pointer over controls stays visible for 30 seconds and never hides cursor', () => {
  const h = harness(); h.show(); h.enter(); h.advance(30000)
  assert.equal(h.state.visible, true); assert.equal(h.cursorHidden(), false); assert.equal(h.timers.size, 0)
  h.dispose()
})
test('leaving controls restarts normal timeout; re-entering cancels it', () => {
  const h = harness(); h.enter(); h.leave(); h.advance(CONTROLS_HIDE_MS - 1)
  assert.equal(h.state.visible, true); h.enter(); h.advance(10000); assert.equal(h.state.visible, true)
  h.leave(); h.advance(CONTROLS_HIDE_MS); assert.equal(h.state.visible, false); assert.equal(h.cursorHidden(), true)
  h.enter(); assert.equal(h.state.visible, true); assert.equal(h.cursorHidden(), false)
  h.dispose()
})
test('menus, paused/loading/error and transitions keep controls and cursor visible', () => {
  for (const blocker of [{ menu: 'audio' }, { playing: false }, { error: { message: 'Failed' } }, { transitioning: true }]) {
    const h = harness(); h.show(); Object.assign(h.playback, blocker); h.refresh(); h.advance(30000)
    assert.equal(h.state.visible, true); assert.equal(h.cursorHidden(), false)
    h.dispose()
  }
})
test('timer rechecks hover and playback, and closing a menu resumes normal countdown', () => {
  const h = harness(); h.show(); h.state.pointerInsideControls = true; h.advance(CONTROLS_HIDE_MS)
  assert.equal(h.state.visible, true)
  h.state.pointerInsideControls = false; h.playback.menu = 'chapters'; h.refresh(); h.advance(30000)
  h.playback.menu = ''; h.refresh(); h.advance(CONTROLS_HIDE_MS)
  assert.equal(h.state.visible, false); h.dispose()
})
