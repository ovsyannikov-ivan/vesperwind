import { traceMedia } from '../api/mediaDiagnostics.js'
export const THUMBNAIL_DWELL_MS = 250

// Do not publish a URL until the complete JPEG has loaded and decoded. The
// detached Image is never visible and is released on cancellation/error.
export const loadThumbnailImage = (url, signal) => new Promise((resolve, reject) => {
  traceMedia('thumbnail.image-load', { urlPrefix: url.slice(0, 23), urlLength: url.length })
  const image = new Image()
  let settled = false
  const finish = (error) => {
    if (settled) return
    settled = true
    image.onload = image.onerror = null
    signal.removeEventListener('abort', abort)
    if (error) { image.src = ''; reject(error) } else resolve(url)
  }
  const abort = () => finish(new Error('Thumbnail cancelled'))
  image.onload = async () => {
    try {
      traceMedia('thumbnail.image-onload', { width: image.naturalWidth, height: image.naturalHeight })
      if (!image.naturalWidth) throw new Error('Invalid thumbnail')
      if (image.decode) await image.decode()
      traceMedia('thumbnail.image-decoded')
      if (signal.aborted) abort()
      else finish()
    } catch (error) { finish(error) }
  }
  image.onerror = () => finish(new Error('Thumbnail load failed'))
  if (signal.aborted) { abort(); return }
  signal.addEventListener('abort', abort, { once: true })
  image.src = url
})

export const createThumbnailPreview = ({ getSource, request, clearCache = () => {},
  loadImage = loadThumbnailImage, setTimer = setTimeout, clearTimer = clearTimeout,
  preview = { visible: false, time: 0, ratio: 0, url: '', loading: false } }) => {
  let timer = null
  let controller = null
  let revision = 0
  let disposed = false
  const invalidate = () => {
    revision++
    if (timer !== null) clearTimer(timer)
    timer = null
    controller?.abort()
    controller = null
    preview.url = ''
    preview.loading = false
  }
  const hide = () => { invalidate(); preview.visible = false }
  const reset = () => { hide(); clearCache() }
  const show = (time, ratio) => {
    if (disposed) return
    if (!Number.isFinite(time)) { hide(); return }
    // Every movement restarts dwell, even within the same half-second bucket.
    invalidate()
    preview.visible = true
    preview.time = Math.max(0, time)
    traceMedia('thumbnail.hover', { time: preview.time })
    preview.ratio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
    const source = { ...getSource() }
    if (!source.path || (source.providerId ?? 'local') !== 'local') return
    const current = revision
    const position = preview.time
    timer = setTimer(async () => {
      timer = null
      traceMedia('thumbnail.dwell', { path: source.path, time: position })
      controller = new AbortController()
      const signal = controller.signal
      try {
        const result = await request({ ...source, time: position, width: 180, signal })
        traceMedia('thumbnail.result', { status: result?.thumbnail?.status, reason: result?.thumbnail?.reason, error: result?.error?.code, current: revision === current })
        if (disposed || revision !== current || signal.aborted || result?.thumbnail?.status !== 'ready') return
        const url = await loadImage(result.thumbnail.url, signal)
        if (!disposed && revision === current && !signal.aborted) { preview.url = url; traceMedia('thumbnail.published', { time: position }) }
      } catch (error) {
        traceMedia('thumbnail.failure', { message: error?.message, cancelled: signal.aborted })
        if (!signal.aborted) console.warn('Thumbnail image could not be shown', error)
      }
    }, THUMBNAIL_DWELL_MS)
  }
  const dispose = () => { disposed = true; reset() }
  return { preview, show, hide, reset, dispose }
}
