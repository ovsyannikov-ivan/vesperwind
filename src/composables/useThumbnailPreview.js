import { onBeforeUnmount, reactive, watch } from 'vue'
import { video } from '../api/video.js'
import { createThumbnailPreview } from '../player/thumbnailPreview.js'

export const useThumbnailPreview = (getSource) => {
  const preview = reactive({ visible: false, time: 0, ratio: 0, url: '', loading: false })
  const controller = createThumbnailPreview({ getSource, preview,
    request: video.getThumbnail, clearCache: video.clearCache })
  watch(() => { const source = getSource(); return [source.path, source.providerId, source.sourceHdr] }, controller.reset, { flush: 'sync' })
  onBeforeUnmount(controller.dispose)
  return { preview, show: controller.show, hide: controller.hide }
}
