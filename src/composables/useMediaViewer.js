import { computed, ref } from 'vue'
import { canPreviewMedia, getMediaKind } from '../../shared/mediaTypes.js'

const mediaUrl = (filePath) =>
  `/api/media?path=${encodeURIComponent(filePath)}`

export const createMediaDescriptor = (node) => ({
  name: node.name,
  path: node.path,
  kind: getMediaKind(node.name),
  url: mediaUrl(node.path),
})

const isSameOrInsidePath = (parentPath, candidatePath) =>
  candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)

const buildPlaylist = (node, siblings, kind) => {
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

  return items.map(createMediaDescriptor)
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

  const openMedia = ({ node, siblings = [] } = {}) => {
    if (!node || !canPreviewMedia(node.name)) {
      return false
    }

    const kind = getMediaKind(node.name)

    if (kind === 'audio') {
      activeAudio.value = createMediaDescriptor(node)
      return true
    }

    if (!['image', 'video'].includes(kind)) {
      return false
    }

    const items = buildPlaylist(node, siblings, kind)
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

    const relocateMedia = (media) => {
      if (!media || !isSameOrInsidePath(sourcePath, media.path)) {
        return media
      }

      const nextPath = `${response.result.destinationPath}${media.path.slice(sourcePath.length)}`

      return {
        ...media,
        path: nextPath,
        url: mediaUrl(nextPath),
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
