import { computed, ref, watch } from 'vue'
import { entryChange, relocatePath } from './useEntryChanges.js'
import { canPreviewMedia, getMediaKind } from '../../shared/mediaTypes.js'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'
import { media as mediaApi } from '../api/media.js'

export const createMediaDescriptor = (
  node,
  providerId = LOCAL_FILESYSTEM_PROVIDER,
) => ({
  name: node.name,
  path: node.path,
  providerId,
  kind: getMediaKind(node.name),
  url: '',
  loading: false,
  statusMessage: 'Preparing file…',
  error: null,
})

const isSameOrInsidePath = (parentPath, candidatePath) =>
  candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)

const buildPlaylist = (node, siblings, kind, providerId) => {
  const candidates = Array.isArray(siblings) ? siblings : []
  const items = candidates.filter(
    (candidate) =>
      !candidate.isDirectory &&
      canPreviewMedia(candidate.name) &&
      getMediaKind(candidate.name) === kind,
  )

  if (!items.some((candidate) => candidate.path === node.path)) {
    items.push(node)
  }

  return items.map((item) => createMediaDescriptor(item, providerId))
}

export const useMediaViewer = () => {
  const activeAudio = ref(null)
  const viewer = ref(null)
  watch(entryChange, (change) => {
    if (change?.action !== 'rename') return
    const relocate = (item) => {
      if (!item || item.providerId !== change.providerId) return item
      const path = relocatePath(item.path, change)
      return path === item.path ? item : { ...item, path, name: path.split('/').at(-1), url: '', error: null }
    }
    activeAudio.value = relocate(activeAudio.value)
    if (viewer.value) viewer.value.items = viewer.value.items.map(relocate)
    if (activeAudio.value && !activeAudio.value.url) void prepareDescriptor(activeAudio.value)
    if (currentViewerMedia.value && !currentViewerMedia.value.url) void prepareDescriptor(currentViewerMedia.value)
  })
  const currentViewerMedia = computed(() =>
    viewer.value ? viewer.value.items[viewer.value.index] : null,
  )
  const viewerPosition = computed(() =>
    viewer.value ? viewer.value.index + 1 : 0,
  )
  const viewerCount = computed(() => viewer.value?.items.length || 0)

  const prepareDescriptor = async (descriptor) => {
    if (!descriptor || descriptor.loading || descriptor.url) return descriptor

    descriptor.loading = true
    descriptor.error = null
    descriptor.statusMessage = 'Preparing file…'
    descriptor.preparationController?.abort()
    const controller = new AbortController()
    descriptor.preparationController = controller

    try {
      const response = await mediaApi.prepare({
        providerId: descriptor.providerId,
        path: descriptor.path,
      }, {
        signal: controller.signal,
        onStatus: (status) => {
          descriptor.statusMessage = status?.userMessage || 'Preparing file…'
          descriptor.preparationProgress = status?.progress ?? null
        },
      })
      if (controller.signal.aborted) return descriptor
      if (response?.ok) descriptor.url = response.source
      else descriptor.error = response?.error || { message: 'Unable to prepare this file' }
    } catch (error) {
      descriptor.error = {
        code: error?.code || 'EMEDIA_PREPARE',
        message: error?.message || 'Unable to prepare this file',
      }
    } finally {
      if (!controller.signal.aborted) descriptor.loading = false
      if (descriptor.preparationController === controller) {
        descriptor.preparationController = null
      }
    }

    return descriptor
  }

  const openMedia = ({
    node,
    siblings = [],
    filesystemId = LOCAL_FILESYSTEM_PROVIDER,
  } = {}) => {
    if (!node || !canPreviewMedia(node.name)) {
      return false
    }

    const kind = getMediaKind(node.name)

    if (kind === 'audio') {
      activeAudio.value?.preparationController?.abort()
      activeAudio.value = createMediaDescriptor(node, filesystemId)
      void prepareDescriptor(activeAudio.value)
      return true
    }

    if (!['image', 'video'].includes(kind)) {
      return false
    }

    const items = buildPlaylist(node, siblings, kind, filesystemId)
    const index = Math.max(
      0,
      items.findIndex((item) => item.path === node.path),
    )
    viewer.value = { kind, items, index }
    void prepareDescriptor(viewer.value.items[index])
    return true
  }

  const closeAudio = () => {
    activeAudio.value?.preparationController?.abort()
    activeAudio.value = null
  }

  const closeViewer = () => {
    currentViewerMedia.value?.preparationController?.abort()
    viewer.value = null
  }

  const stepViewer = (delta) => {
    const itemCount = viewer.value?.items.length || 0

    if (itemCount < 2) {
      return
    }

    currentViewerMedia.value?.preparationController?.abort()
    viewer.value.index =
      (viewer.value.index + delta + itemCount) % itemCount
    void prepareDescriptor(viewer.value.items[viewer.value.index])
  }

  const retryMedia = () => {
    const descriptor = activeAudio.value?.error
      ? activeAudio.value
      : currentViewerMedia.value
    if (!descriptor) return
    descriptor.error = null
    descriptor.url = ''
    void prepareDescriptor(descriptor)
  }

  const showPrevious = () => stepViewer(-1)
  const showNext = () => stepViewer(1)

  const syncAfterFileOperation = (requestDetails, response) => {
    if (!requestDetails?.source?.path || !response?.result) {
      return
    }

    const sourcePath = requestDetails.source.path

    if (requestDetails.action === 'delete') {
      if (
        activeAudio.value &&
        isSameOrInsidePath(sourcePath, activeAudio.value.path)
      ) {
        activeAudio.value = null
      }

      if (viewer.value) {
        const currentPath = currentViewerMedia.value?.path
        const nextItems = viewer.value.items.filter(
          (item) => !isSameOrInsidePath(sourcePath, item.path),
        )

        if (nextItems.length === 0) {
          viewer.value = null
        } else {
          const retainedIndex = nextItems.findIndex(
            (item) => item.path === currentPath,
          )
          viewer.value.items = nextItems
          viewer.value.index =
            retainedIndex >= 0
              ? retainedIndex
              : Math.min(viewer.value.index, nextItems.length - 1)
        }
      }

      return
    }

    if (requestDetails.action !== 'move' || !response.result.destinationPath) {
      return
    }

    const relocateMedia = (mediaItem) => {
      if (!mediaItem || !isSameOrInsidePath(sourcePath, mediaItem.path)) {
        return mediaItem
      }

      const nextPath = `${response.result.destinationPath}${mediaItem.path.slice(sourcePath.length)}`

      return {
        ...mediaItem,
        path: nextPath,
        url: '',
        error: null,
      }
    }

    activeAudio.value = relocateMedia(activeAudio.value)

    if (viewer.value) {
      viewer.value.items = viewer.value.items.map(relocateMedia)
    }

    if (activeAudio.value && !activeAudio.value.url) {
      void prepareDescriptor(activeAudio.value)
    }
    if (currentViewerMedia.value && !currentViewerMedia.value.url) {
      void prepareDescriptor(currentViewerMedia.value)
    }
  }

  return {
    activeAudio,
    viewer,
    currentViewerMedia,
    viewerPosition,
    viewerCount,
    openMedia,
    closeAudio,
    closeViewer,
    showPrevious,
    showNext,
    retryMedia,
    syncAfterFileOperation,
  }
}
