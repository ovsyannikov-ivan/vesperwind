export const CONTROLS_HIDE_MS = 2750

// Pointer presence is driven by containment events, never polling.
export const createControlsVisibility = ({ state, getPlayback, setTimer = setTimeout, clearTimer = clearTimeout }) => {
  let timer = null
  let disposed = false
  const blocked = () => {
    const playback = getPlayback()
    return state.pointerInsideControls || !playback.playing || playback.menu || playback.error || playback.transitioning
  }
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null }
  const restore = () => { clear(); state.visible = true }
  const schedule = () => {
    clear()
    if (disposed || blocked()) return
    timer = setTimer(() => {
      timer = null
      if (!disposed && !blocked()) state.visible = false
      else restore()
    }, CONTROLS_HIDE_MS)
  }
  const show = () => { restore(); schedule() }
  return {
    show, restore, schedule,
    enter() { state.pointerInsideControls = true; restore() },
    leave() { state.pointerInsideControls = false; show() },
    refresh() { if (blocked()) restore(); else schedule() },
    cursorHidden() { return !state.visible && !blocked() },
    dispose() { disposed = true; restore(); state.pointerInsideControls = false },
  }
}
