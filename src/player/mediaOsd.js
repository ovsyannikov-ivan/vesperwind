import { formatMediaDuration, formatMediaTrack } from '../utils/mediaInfo.js'

export const formatMediaOsd = (event) => {
  if (!event) return null
  if (event.kind === 'audio' || event.kind === 'subtitle') return {
    title: event.kind === 'audio' ? 'Audio' : 'Subtitles',
    detail: event.track ? formatMediaTrack(event.track) : 'Off',
  }
  const title = { play: 'Play', pause: 'Pause', resume: 'Play' }[event.kind]
  return title ? { title, detail: `${formatMediaDuration(event.currentTime)} / ${formatMediaDuration(event.duration)}` } : null
}

// Replacement, never a queue. A persisted native event may arrive when the
// overlay attaches after open; its wall-clock age prevents stale replay.
export const createMediaOsd = ({ onChange, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, duration = 1800 }) => {
  let timer = null
  let seen = null
  let revision = 0
  const reset = () => { revision++; clearTimer(timer); timer = null; onChange(null) }
  const accept = (event) => {
    if (!event || event.id === seen) return
    seen = event.id
    const age = Math.max(0, now() - event.createdAt)
    // Restore precedes native overlay attachment. Give its first delivery a full
    // display interval while still rejecting events from an old session.
    const remaining = event.kind === 'resume' && age < 10000 ? duration : duration - age
    const content = formatMediaOsd(event)
    if (!content || remaining <= 0) return
    reset()
    const current = revision
    onChange(content)
    timer = setTimer(() => { if (current === revision) { timer = null; onChange(null) } }, remaining)
  }
  return { accept, reset, dispose: reset }
}
