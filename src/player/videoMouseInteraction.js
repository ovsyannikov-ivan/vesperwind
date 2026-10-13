// Measure on each click: the same surface works after resize/fullscreen.
export const videoMouseAction = (x, y, rect) => {
  if (
    !(rect?.width > 0 && rect?.height > 0) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    return null
  if (
    x < rect.left ||
    x > rect.left + rect.width ||
    y < rect.top ||
    y > rect.top + rect.height
  )
    return null
  const fraction = (x - rect.left) / rect.width
  return fraction < 0.25 ? 'backward' : fraction < 0.75 ? 'toggle' : 'forward'
}

export const createVideoMouseInteraction = ({
  enabled,
  getRect,
  onSeek,
  onToggle,
  onFullscreen = () => {},
  clickDelay = 300,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let press = null
  let toggleTimer = null
  let doubleClickReady = false
  let revision = 0
  const cancelToggle = () => {
    revision++
    if (toggleTimer !== null) clearTimer(toggleTimer)
    toggleTimer = null
  }
  const cancelPress = () => {
    press = null
  }
  const reset = () => {
    cancelPress()
    cancelToggle()
    doubleClickReady = false
  }
  const move = (event) => {
    if (!press || event.pointerId !== press.id) return
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4)
      press.dragged = true
  }
  return {
    reset,
    cancelPress,
    down(event) {
      cancelPress()
      doubleClickReady = false
      if (
        !enabled() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.pointerType !== 'mouse' ||
        event.isPrimary === false ||
        event.target !== event.currentTarget
      )
        return
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragged: false,
        released: false,
      }
    },
    move,
    up(event) {
      move(event)
      if (press && event.pointerId === press.id && event.button === 0)
        press.released = true
      else cancelPress()
    },
    click(event) {
      // Always stop the built-in media gesture receiver, including when disabled.
      event.stopPropagation()
      event.preventDefault()
      const completed = press
      cancelPress()
      if (
        !completed?.released ||
        completed.dragged ||
        event.button !== 0 ||
        !enabled() ||
        event.target !== event.currentTarget
      )
        return
      const action = videoMouseAction(event.clientX, event.clientY, getRect())
      if (action === 'toggle') {
        cancelToggle()
        if (event.detail > 1) {
          doubleClickReady = true
          return
        }
        // Defer only the middle zone so a double click does not also toggle
        // playback. Seek clicks keep their immediate accumulation/feedback.
        const current = revision
        toggleTimer = setTimer(() => {
          if (current !== revision) return
          toggleTimer = null
          if (enabled()) onToggle()
        }, clickDelay)
      } else if (action) onSeek(action === 'forward' ? 10 : -10)
    },
    doubleClick(event) {
      event.stopPropagation()
      event.preventDefault()
      const ready = doubleClickReady
      cancelPress()
      doubleClickReady = false
      if (
        ready &&
        enabled() &&
        event.button === 0 &&
        event.target === event.currentTarget &&
        videoMouseAction(event.clientX, event.clientY, getRect()) === 'toggle'
      ) {
        cancelToggle()
        onFullscreen()
      }
    },
  }
}

// Commands use the existing player state/API. Ignore overlaps until its command
// has returned; a delayed state notification must not send the same toggle twice.
export const createPlaybackToggle = ({
  enabled,
  getPlayer,
  isPlaying,
  onError,
}) => {
  let pending = false,
    revision = 0
  return {
    reset() {
      revision++
      pending = false
    },
    async toggle() {
      const player = getPlayer()
      if (pending || !enabled() || !player) return false
      const current = revision
      pending = true
      try {
        await (isPlaying() ? player.pause() : player.play())
        return true
      } catch (error) {
        if (current === revision) onError(error)
        return false
      } finally {
        if (current === revision) pending = false
      }
    },
  }
}
