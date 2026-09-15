import { computed, ref } from 'vue'
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
  url: mediaApi.getUrl({ providerId, path: node.path }),
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
  const currentViewerMedia = computed(() =>
    viewer.value ? viewer.value.items[viewer.value.index] : null,
  )
  const viewerPosition = computed(() =>
    viewer.value ? viewer.value.index + 1 : 0,
  )
  const viewerCount = computed(() => viewer.value?.items.length || 0)

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
      activeAudio.value = createMediaDescriptor(node, filesystemId)
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
    return true
  }

  const closeAudio = () => {
    activeAudio.value = null
  }

  const closeViewer = () => {
    viewer.value = null
  }

  const stepViewer = (delta) => {
    const itemCount = viewer.value?.items.length || 0

    if (itemCount < 2) {
      return
    }

    viewer.value.index =
      (viewer.value.index + delta + itemCount) % itemCount
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
        url: mediaApi.getUrl({
          providerId: mediaItem.providerId,
          path: nextPath,
        }),
      }
    }

    activeAudio.value = relocateMedia(activeAudio.value)

    if (viewer.value) {
      viewer.value.items = viewer.value.items.map(relocateMedia)
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
    syncAfterFileOperation,
  }
}
