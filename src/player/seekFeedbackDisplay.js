// Presentation lifetime is independent of pending seek/progress state.
export const createSeekFeedbackDisplay = ({
  onChange,
  duration = 1200,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let timer = null,
    revision = 0
  const cancel = () => {
    revision++
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const reset = () => {
    cancel()
    onChange(null)
  }
  return {
    reset,
    update(value, { committed = false } = {}) {
      if (value) {
        cancel()
        onChange(value)
        return
      }
      if (!committed) {
        reset()
        return
      }
      cancel()
      const current = revision
      timer = setTimer(() => {
        if (current !== revision) return
        timer = null
        onChange(null)
      }, duration)
    },
  }
}
