// Browser/SEA have no libmpv. Reuse one paused metadata element for the entire
// queue; it never participates in player controls and never starts playback.
export const createWebAudioMetadataProbe = ({ prepare, createElement = () => document.createElement('audio'), timeoutMs = 10000 }) => {
  let element = null, cancel = null, disposed = false
  const probe = async (location) => {
    if (disposed) return { ok: true, duration: null, chapters: [] }
    const prepared = await prepare(location)
    if (disposed || !prepared?.ok) return { ok: true, duration: null, chapters: [] }
    element ||= createElement()
    element.autoplay = false
    element.preload = 'metadata'
    return new Promise((resolve) => {
      let timer
      const finish = () => {
        clearTimeout(timer)
        element.removeEventListener('loadedmetadata', finish)
        element.removeEventListener('error', finish)
        const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null
        cancel = null
        element.removeAttribute('src')
        element.load()
        resolve({ ok: true, duration, chapters: [] })
      }
      cancel = finish
      element.addEventListener('loadedmetadata', finish)
      element.addEventListener('error', finish)
      timer = setTimeout(finish, timeoutMs)
      element.src = prepared.source
      element.load()
    })
  }
  return { probe, dispose: () => { disposed = true; cancel?.(); element = null } }
}
