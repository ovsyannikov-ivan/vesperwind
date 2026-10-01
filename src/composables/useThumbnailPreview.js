import { onBeforeUnmount, reactive, watch } from 'vue'
import { video } from '../api/video.js'

export const useThumbnailPreview = (getSource) => {
  const preview = reactive({ visible: false, time: 0, ratio: 0, url: '', loading: false })
  let timer = null
  let controller = null
  let revision = 0
  const cancel = () => {
    revision += 1
    clearTimeout(timer)
    timer = null
    controller?.abort()
    controller = null
    preview.loading = false
    preview.url = ''
  }
  const hide = () => { cancel(); preview.visible = false }
  const show = (time, ratio) => {
    if (!Number.isFinite(time)) { hide(); return }
    revision += 1
    controller?.abort()
    preview.url = ''
    preview.visible = true
    preview.time = Math.max(0, time)
    preview.ratio = Math.max(0, Math.min(1, ratio))
    const source = getSource()
    if (!source.path || source.providerId !== 'local') {
      clearTimeout(timer)
      timer = null
      preview.loading = false
      return
    }
    preview.loading = true
    // Sample the latest position at most every 100ms, including during a drag.
    if (timer !== null) return
    timer = setTimeout(async () => {
      timer = null
      const current = revision
      controller = new AbortController()
      const signal = controller.signal
      const result = await video.getThumbnail({ ...getSource(), time: preview.time, width: 180, signal })
      if (revision !== current || signal.aborted) return
      preview.url = result?.thumbnail?.status === 'ready' ? result.thumbnail.url : ''
      preview.loading = false
    }, 100)
  }
  watch(() => { const source = getSource(); return [source.path, source.providerId, source.sourceHdr] }, () => {
    hide()
    video.clearCache()
  })
  onBeforeUnmount(hide)
  return { preview, show, hide }
}
