import { normalizeMediaSource, mediaSourceLabel } from '../player/mediaSource.js'
import { computed, ref, watch } from 'vue'
import { entryChange, relocatePath } from './useEntryChanges.js'
import { canPreviewMedia, getMediaKind } from '../../shared/mediaTypes.js'
import { LOCAL_FILESYSTEM_PROVIDER } from '../api/filesystemLocation.js'
import { useAudioPlayer } from './useAudioPlayer.js'
import { media as mediaApi } from '../api/media.js'
import {
  getFilesystemPathName,
  isSameOrDescendantPath,
} from '../utils/filesystemPath.js'

export const createMediaDescriptor = (
  node,
  providerId = LOCAL_FILESYSTEM_PROVIDER,
) => ({
  sourceType: 'provider',
  name: node.name,
  path: node.path,
  providerId,
  kind: getMediaKind(node.name),
  preparedSource: '',
  loading: false,
  statusMessage: 'Preparing file…',
  error: null,
})

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

export const useMediaViewer = ({ audio = useAudioPlayer(), prepareMedia = mediaApi.prepare } = {}) => {
  const activeAudio = audio.current
  const viewer = ref(null)
  watch(entryChange, (change) => {
    if (change?.action !== 'rename') return
    const relocate = (item) => {
      if (!item || item.sourceType === 'url' || item.providerId !== change.providerId) return item
      const path = relocatePath(item.path, change)
      return path === item.path
        ? item
        : { ...item, path, name: getFilesystemPathName(path), preparedSource: '', error: null }
    }
    if (viewer.value) viewer.value.items = viewer.value.items.map(relocate)
    if (currentViewerMedia.value && !currentViewerMedia.value.preparedSource) void prepareDescriptor(currentViewerMedia.value)
  })
  const currentViewerMedia = computed(() =>
    viewer.value ? viewer.value.items[viewer.value.index] : null,
  )
  const viewerPosition = computed(() =>
    viewer.value ? viewer.value.index + 1 : 0,
  )
  const viewerCount = computed(() => viewer.value?.items.length || 0)

  const prepareDescriptor = async (descriptor) => {
    if (!descriptor || descriptor.loading || descriptor.preparedSource) return descriptor

    descriptor.loading = true
    descriptor.error = null
    descriptor.statusMessage = 'Preparing file…'
    descriptor.preparationController?.abort()
    const controller = new AbortController()
    descriptor.preparationController = controller

    try {
      const response = await prepareMedia(normalizeMediaSource(descriptor), {
        signal: controller.signal,
        onStatus: (status) => {
          descriptor.statusMessage = status?.userMessage || 'Preparing file…'
          descriptor.preparationProgress = status?.progress ?? null
        },
      })
      if (controller.signal.aborted) return descriptor
      if (response?.ok) descriptor.preparedSource = response.source
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

    if (kind === 'audio') return audio.open(node, filesystemId)

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

  const openSource = (source, metadata) => {
    const location = normalizeMediaSource(source)
    const descriptor = { ...location, name: source.name || mediaSourceLabel(location), kind: metadata.kind,
      duration: metadata.duration, tags: metadata.tags, chapters: metadata.chapters, live: metadata.live, metadataLoaded: true,
      preparedSource: '', loading: false, error: null, historyEnabled: location.sourceType !== 'url' && !metadata.live }
    if (metadata.kind === 'audio') return audio.open({ ...descriptor, kind: 'audio' }, location.providerId)
    if (metadata.kind !== 'video') throw new Error('This source has no playable audio or video tracks')
    viewer.value = { kind: 'video', items: [descriptor], index: 0 }
    void prepareDescriptor(viewer.value.items[0])
    return true
  }
  const closeAudio = audio.hide

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
    if (activeAudio.value?.error) return audio.retry()
    const descriptor = currentViewerMedia.value
    if (!descriptor) return
    descriptor.error = null
    descriptor.preparedSource = ''
    void prepareDescriptor(descriptor)
  }

  const showPrevious = () => stepViewer(-1)
  const showNext = () => stepViewer(1)

  const syncAfterFileOperation = (requestDetails, response) => {
    audio.syncAfterFileOperation(requestDetails, response)
    if (!requestDetails?.source?.path || !response?.result) {
      return
    }

    const sourcePath = requestDetails.source.path

    if (requestDetails.action === 'delete') {
      if (viewer.value) {
        const currentPath = currentViewerMedia.value?.path
        const nextItems = viewer.value.items.filter(
          (item) => item.sourceType === 'url' || item.providerId !== (requestDetails.source.providerId || requestDetails.source.filesystemId || 'local') || !isSameOrDescendantPath(sourcePath, item.path),
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
      if (mediaItem.sourceType === 'url' || mediaItem.providerId !== (requestDetails.source.providerId || requestDetails.source.filesystemId || 'local')) return mediaItem
      if (!mediaItem || !isSameOrDescendantPath(sourcePath, mediaItem.path)) {
        return mediaItem
      }

      const nextPath = `${response.result.destinationPath}${mediaItem.path.slice(sourcePath.length)}`

      return {
        ...mediaItem,
        path: nextPath,
        preparedSource: '',
        error: null,
      }
    }


    if (viewer.value) {
      viewer.value.items = viewer.value.items.map(relocateMedia)
    }

    if (currentViewerMedia.value && !currentViewerMedia.value.preparedSource) {
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
    openSource,
    closeAudio,
    closeViewer,
    showPrevious,
    showNext,
    retryMedia,
    syncAfterFileOperation,
  }
}
