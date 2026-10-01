// A burst is anchored to its first keypress, even while playback keeps advancing.
export const clampTime = (time, duration) => Math.max(0, Math.min(Number(duration) || 0, Number(time) || 0))

export const canHandleSeekKey = (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return false
  return !event.composedPath().some((node) => node?.matches?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role^="menu"]',
  ))
}

export const createSeekController = ({ getTime, getDuration, seek, onChange = () => {}, onError = () => {},
  delay = 180, setTimer = setTimeout, clearTimer = clearTimeout }) => {
  let timer = null
  let origin = null
  let pendingSeekDelta = 0
  const reset = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    origin = null
    pendingSeekDelta = 0
    onChange(null)
  }
  const flush = () => {
    if (origin === null) return
    const target = clampTime(origin + pendingSeekDelta, getDuration())
    const start = origin
    reset()
    if (target !== start) {
      try { Promise.resolve(seek(target)).catch(onError) } catch (error) { onError(error) }
    }
  }
  return {
    add(delta) {
      if (!(getDuration() > 0)) return false
      if (origin === null) origin = clampTime(getTime(), getDuration())
      // Saturate at either edge so reversing direction responds immediately.
      const target = clampTime(origin + pendingSeekDelta + delta, getDuration())
      pendingSeekDelta = target - origin
      onChange({ target, delta: pendingSeekDelta })
      if (timer !== null) clearTimer(timer)
      timer = setTimer(flush, delay)
      return true
    },
    flush,
    reset,
  }
}
