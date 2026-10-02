import { clampTime } from './seekController.js'

export const progressTimeAtPointer = (clientX, rect, duration, inset = 8) => {
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2)))
  return { ratio, time: clampTime(ratio * duration, duration) }
}

// Commit the captured pointer target, rather than reading the DOM range value
// after WebKit releases pointer capture and Vue applies a playback snapshot.
export const createProgressDrag = ({ getDuration, preview, onDrag, onCommit, onChange }) => {
  let pointer = null
  let target = null
  const update = (event) => {
    const value = progressTimeAtPointer(event.clientX, event.currentTarget.getBoundingClientRect(), getDuration())
    preview(value.time, value.ratio)
    if (pointer === event.pointerId) { target = value.time; onChange(target) }
  }
  const start = (event) => {
    if (!getDuration()) return
    event.preventDefault()
    pointer = event.pointerId
    event.currentTarget.setPointerCapture(pointer)
    onDrag()
    update(event)
  }
  const end = (event) => {
    if (pointer !== event.pointerId || target == null) return
    const time = target
    pointer = null
    target = null
    // Commit before capture loss or a subsequent snapshot can reset the UI value.
    onCommit(time)
    onChange(null)
  }
  const cancel = () => { pointer = null; target = null; onChange(null) }
  return { start, update, end, cancel, active: () => pointer !== null }
}
