<script setup>
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import { calculatePdfOutputScale } from '../utils/pdfRendering.js'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const PAGE_GAP = 12
const PAGE_PADDING = 16
const THUMBNAIL_WIDTH = 132
const MAX_MAIN_CANVAS_PIXELS = 16 * 1024 * 1024
const MAX_THUMBNAIL_CANVAS_PIXELS = 1024 * 1024

const props = defineProps({
  tab: {
    type: Object,
    required: true,
  },
  visible: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['state-change', 'prepare-retry'])
const viewerElement = ref(null)
const scrollElement = ref(null)
const thumbnailElement = ref(null)
const documentLoading = ref(false)
const errorMessage = ref('')
const isFullscreen = ref(false)
const loaded = ref(false)
const pages = ref([])
const displayScale = ref(1)

const pageElements = new Map()
const canvasElements = new Map()
const thumbnailElements = new Map()
const thumbnailCanvasElements = new Map()
const nearbyPages = new Set()
const nearbyThumbnails = new Set()
const mainRenderTasks = new Map()
const thumbnailRenderTasks = new Map()

let mounted = false
let loadingTask = null
let pdfDocument = null
let firstPageSize = null
let mainObserver = null
let thumbnailObserver = null
let resizeObserver = null
let scrollFrame = null
let resizeFrame = null
let mainGeneration = 0
let thumbnailGeneration = 0
let mainRenderQueue = []
let thumbnailRenderQueue = []
let mainQueueRunning = false
let thumbnailQueueRunning = false
let restoringView = false

const sourceUrl = computed(() => props.tab.sourceUrl || '')
const currentPage = computed(() => props.tab.currentPage || 1)
const pageCount = computed(() => props.tab.pageCount || 0)
const thumbnailsOpen = computed(() => props.tab.thumbnailsOpen !== false)
const zoomLabel = computed(() => `${Math.round(displayScale.value * 100)}%`)
const ready = computed(
  () => loaded.value && !documentLoading.value && !errorMessage.value,
)
const canGoPrevious = computed(() => ready.value && currentPage.value > 1)
const canGoNext = computed(
  () => ready.value && currentPage.value < pageCount.value,
)

const updateState = (state) => {
  emit('state-change', props.tab.id, state)
}

const describeLoadError = (error) => {
  if (error?.name === 'PasswordException') {
    return 'This PDF is encrypted and cannot be opened without a password.'
  }

  if (error?.name === 'InvalidPDFException') {
    return 'This PDF is damaged or has an unsupported structure.'
  }

  if (error?.name === 'MissingPDFException' || error?.status === 404) {
    return 'This PDF no longer exists.'
  }

  if (error?.status === 403) {
    return 'Permission denied while opening this PDF.'
  }

  return error?.message || 'Unable to open this PDF.'
}

const pageState = (pageNumber) => pages.value[pageNumber - 1]

const pageFrameStyle = (page) => ({
  width: `${Math.max(1, page.baseWidth * displayScale.value)}px`,
  height: `${Math.max(1, page.baseHeight * displayScale.value)}px`,
})

const thumbnailFrameStyle = (page) => ({
  width: `${THUMBNAIL_WIDTH}px`,
  height: `${Math.max(1, (page.baseHeight / page.baseWidth) * THUMBNAIL_WIDTH)}px`,
})

const calculateScale = () => {
  if (!firstPageSize) {
    return props.tab.zoom || 1
  }

  const availableWidth = Math.max(
    120,
    (scrollElement.value?.clientWidth || 0) - PAGE_PADDING * 2,
  )
  const availableHeight = Math.max(
    120,
    (scrollElement.value?.clientHeight || 0) - PAGE_PADDING * 2,
  )

  if (props.tab.zoomMode === 'fit-width') {
    return Math.max(0.1, Math.min(8, availableWidth / firstPageSize.width))
  }

  if (props.tab.zoomMode === 'fit-page') {
    return Math.max(
      0.1,
      Math.min(
        8,
        availableWidth / firstPageSize.width,
        availableHeight / firstPageSize.height,
      ),
    )
  }

  return Math.max(0.25, Math.min(4, props.tab.zoom || 1))
}

const clearCanvas = (canvas) => {
  if (!canvas) {
    return
  }

  canvas.width = 0
  canvas.height = 0
  canvas.style.width = ''
  canvas.style.height = ''
}

const cancelTask = (tasks, pageNumber) => {
  tasks.get(pageNumber)?.cancel()
  tasks.delete(pageNumber)
}

const clearMainPage = (pageNumber) => {
  cancelTask(mainRenderTasks, pageNumber)
  clearCanvas(canvasElements.get(pageNumber))
  const page = pageState(pageNumber)

  if (page) {
    page.rendering = false
    page.renderedScale = null
  }
}

const clearThumbnail = (pageNumber) => {
  cancelTask(thumbnailRenderTasks, pageNumber)
  clearCanvas(thumbnailCanvasElements.get(pageNumber))
  const page = pageState(pageNumber)

  if (page) {
    page.thumbnailRendering = false
    page.thumbnailRendered = false
  }
}

const clearRenderedPages = () => {
  mainGeneration += 1
  thumbnailGeneration += 1
  mainRenderQueue = []
  thumbnailRenderQueue = []

  for (const task of mainRenderTasks.values()) {
    task.cancel()
  }

  for (const task of thumbnailRenderTasks.values()) {
    task.cancel()
  }

  mainRenderTasks.clear()
  thumbnailRenderTasks.clear()

  for (const page of pages.value) {
    clearCanvas(canvasElements.get(page.number))
    clearCanvas(thumbnailCanvasElements.get(page.number))
    page.rendering = false
    page.renderedScale = null
    page.thumbnailRendering = false
    page.thumbnailRendered = false
  }
}

const updatePageDimensions = (pageNumber, viewport) => {
  const page = pageState(pageNumber)

  if (!page) {
    return
  }

  if (
    Math.abs(page.baseWidth - viewport.width) > 0.01 ||
    Math.abs(page.baseHeight - viewport.height) > 0.01
  ) {
    page.baseWidth = viewport.width
    page.baseHeight = viewport.height
  }
}

const renderMainPage = async (pageNumber, generation) => {
  const page = pageState(pageNumber)
  const canvas = canvasElements.get(pageNumber)

  if (
    !page ||
    !canvas ||
    !mounted ||
    !props.visible ||
    !pdfDocument ||
    generation !== mainGeneration ||
    page.renderedScale === displayScale.value
  ) {
    return
  }

  page.rendering = true
  page.error = ''

  try {
    const pdfPage = await pdfDocument.getPage(pageNumber)

    if (!props.visible || generation !== mainGeneration) {
      return
    }

    const baseViewport = pdfPage.getViewport({ scale: 1 })
    updatePageDimensions(pageNumber, baseViewport)
    const scale = displayScale.value
    const viewport = pdfPage.getViewport({ scale })
    const outputScale = calculatePdfOutputScale(
      viewport,
      2,
      MAX_MAIN_CANVAS_PIXELS,
      window.devicePixelRatio,
    )
    const context = canvas.getContext('2d', { alpha: false })

    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const renderTask = pdfPage.render({
      canvasContext: context,
      viewport,
      transform:
        Math.abs(outputScale - 1) < 0.001
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0],
    })
    mainRenderTasks.set(pageNumber, renderTask)
    await renderTask.promise

    if (props.visible && generation === mainGeneration) {
      page.renderedScale = scale
    } else {
      clearCanvas(canvas)
    }
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException' && generation === mainGeneration) {
      page.error = error?.message || 'Unable to render this page.'
    }
  } finally {
    mainRenderTasks.delete(pageNumber)

    if (generation === mainGeneration) {
      page.rendering = false
    }
  }
}

const renderThumbnail = async (pageNumber, generation) => {
  const page = pageState(pageNumber)
  const canvas = thumbnailCanvasElements.get(pageNumber)

  if (
    !page ||
    !canvas ||
    !mounted ||
    !props.visible ||
    !thumbnailsOpen.value ||
    !pdfDocument ||
    generation !== thumbnailGeneration ||
    page.thumbnailRendered
  ) {
    return
  }

  page.thumbnailRendering = true

  try {
    const pdfPage = await pdfDocument.getPage(pageNumber)

    if (
      !props.visible ||
      !thumbnailsOpen.value ||
      generation !== thumbnailGeneration
    ) {
      return
    }

    const baseViewport = pdfPage.getViewport({ scale: 1 })
    updatePageDimensions(pageNumber, baseViewport)
    const viewport = pdfPage.getViewport({
      scale: THUMBNAIL_WIDTH / baseViewport.width,
    })
    const outputScale = calculatePdfOutputScale(
      viewport,
      1.5,
      MAX_THUMBNAIL_CANVAS_PIXELS,
      window.devicePixelRatio,
    )
    const context = canvas.getContext('2d', { alpha: false })

    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const renderTask = pdfPage.render({
      canvasContext: context,
      viewport,
      transform:
        Math.abs(outputScale - 1) < 0.001
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0],
    })
    thumbnailRenderTasks.set(pageNumber, renderTask)
    await renderTask.promise

    if (
      props.visible &&
      thumbnailsOpen.value &&
      generation === thumbnailGeneration
    ) {
      page.thumbnailRendered = true
    } else {
      clearCanvas(canvas)
    }
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') {
      page.thumbnailRendered = false
    }
  } finally {
    thumbnailRenderTasks.delete(pageNumber)

    if (generation === thumbnailGeneration) {
      page.thumbnailRendering = false
    }
  }
}

const drainMainRenderQueue = async () => {
  if (mainQueueRunning) {
    return
  }

  mainQueueRunning = true
  const generation = mainGeneration

  try {
    while (
      mainRenderQueue.length > 0 &&
      mounted &&
      props.visible &&
      generation === mainGeneration
    ) {
      await renderMainPage(mainRenderQueue.shift(), generation)
    }
  } finally {
    mainQueueRunning = false

    if (mainRenderQueue.length > 0 && mounted && props.visible) {
      drainMainRenderQueue()
    }
  }
}

const drainThumbnailRenderQueue = async () => {
  if (thumbnailQueueRunning) {
    return
  }

  thumbnailQueueRunning = true
  const generation = thumbnailGeneration

  try {
    while (
      thumbnailRenderQueue.length > 0 &&
      mounted &&
      props.visible &&
      thumbnailsOpen.value &&
      generation === thumbnailGeneration
    ) {
      await renderThumbnail(thumbnailRenderQueue.shift(), generation)
    }
  } finally {
    thumbnailQueueRunning = false

    if (
      thumbnailRenderQueue.length > 0 &&
      mounted &&
      props.visible &&
      thumbnailsOpen.value
    ) {
      drainThumbnailRenderQueue()
    }
  }
}

const queueMainPages = (pageNumbers) => {
  if (!ready.value || !props.visible) {
    return
  }

  const candidates = [...new Set(pageNumbers)]
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount.value)
    .filter((pageNumber) => {
      const page = pageState(pageNumber)
      return page && page.renderedScale !== displayScale.value && !page.rendering
    })
    .sort(
      (left, right) =>
        Math.abs(left - currentPage.value) - Math.abs(right - currentPage.value),
    )

  for (const pageNumber of candidates) {
    if (!mainRenderQueue.includes(pageNumber)) {
      mainRenderQueue.push(pageNumber)
    }
  }

  drainMainRenderQueue()
}

const queueThumbnails = (pageNumbers) => {
  if (!ready.value || !props.visible || !thumbnailsOpen.value) {
    return
  }

  const candidates = [...new Set(pageNumbers)]
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount.value)
    .filter((pageNumber) => {
      const page = pageState(pageNumber)
      return page && !page.thumbnailRendered && !page.thumbnailRendering
    })
    .sort(
      (left, right) =>
        Math.abs(left - currentPage.value) - Math.abs(right - currentPage.value),
    )

  for (const pageNumber of candidates) {
    if (!thumbnailRenderQueue.includes(pageNumber)) {
      thumbnailRenderQueue.push(pageNumber)
    }
  }

  drainThumbnailRenderQueue()
}

const clearDistantMainPages = () => {
  const retainedPages = new Set(nearbyPages)

  for (let offset = -1; offset <= 1; offset += 1) {
    retainedPages.add(currentPage.value + offset)
  }

  for (const page of pages.value) {
    if (
      (page.renderedScale !== null || page.rendering) &&
      !retainedPages.has(page.number)
    ) {
      clearMainPage(page.number)
    }
  }
}

const clearDistantThumbnails = () => {
  const retainedPages = new Set(nearbyThumbnails)

  for (let offset = -1; offset <= 1; offset += 1) {
    retainedPages.add(currentPage.value + offset)
  }

  for (const page of pages.value) {
    if (
      (page.thumbnailRendered || page.thumbnailRendering) &&
      !retainedPages.has(page.number)
    ) {
      clearThumbnail(page.number)
    }
  }
}

const createMainObserver = () => {
  mainObserver?.disconnect()
  nearbyPages.clear()

  if (!scrollElement.value) {
    return
  }

  mainObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber)

        if (entry.isIntersecting) {
          nearbyPages.add(pageNumber)
        } else {
          nearbyPages.delete(pageNumber)
        }
      }

      queueMainPages([...nearbyPages])
      clearDistantMainPages()
    },
    {
      root: scrollElement.value,
      rootMargin: '100% 0px',
      threshold: 0.01,
    },
  )

  for (const element of pageElements.values()) {
    mainObserver.observe(element)
  }
}

const createThumbnailObserver = () => {
  thumbnailObserver?.disconnect()
  nearbyThumbnails.clear()

  if (!thumbnailElement.value || !thumbnailsOpen.value) {
    return
  }

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber)

        if (entry.isIntersecting) {
          nearbyThumbnails.add(pageNumber)
        } else {
          nearbyThumbnails.delete(pageNumber)
        }
      }

      queueThumbnails([...nearbyThumbnails, currentPage.value])
      clearDistantThumbnails()
    },
    {
      root: thumbnailElement.value,
      rootMargin: '240px 0px',
      threshold: 0.01,
    },
  )

  for (const element of thumbnailElements.values()) {
    thumbnailObserver.observe(element)
  }
}

const setPageElement = (element, pageNumber) => {
  const previous = pageElements.get(pageNumber)

  if (previous && previous !== element) {
    mainObserver?.unobserve(previous)
  }

  if (element) {
    pageElements.set(pageNumber, element)
    mainObserver?.observe(element)
  } else {
    pageElements.delete(pageNumber)
  }
}

const setCanvasElement = (element, pageNumber) => {
  if (element) {
    canvasElements.set(pageNumber, element)
  } else {
    canvasElements.delete(pageNumber)
  }
}

const setThumbnailElement = (element, pageNumber) => {
  const previous = thumbnailElements.get(pageNumber)

  if (previous && previous !== element) {
    thumbnailObserver?.unobserve(previous)
  }

  if (element) {
    thumbnailElements.set(pageNumber, element)
    thumbnailObserver?.observe(element)
  } else {
    thumbnailElements.delete(pageNumber)
  }
}

const setThumbnailCanvasElement = (element, pageNumber) => {
  if (element) {
    thumbnailCanvasElements.set(pageNumber, element)
  } else {
    thumbnailCanvasElements.delete(pageNumber)
  }
}

const scrollThumbnailIntoView = (pageNumber) => {
  const container = thumbnailElement.value
  const element = thumbnailElements.get(pageNumber)

  if (!container || !element || !thumbnailsOpen.value) {
    return
  }

  const top = element.offsetTop
  const bottom = top + element.offsetHeight

  if (top < container.scrollTop) {
    container.scrollTop = top
  } else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight
  }
}

const updateCurrentPageFromScroll = () => {
  const container = scrollElement.value

  if (!container || restoringView || pages.value.length === 0) {
    return
  }

  const containerRect = container.getBoundingClientRect()
  let bestPage = currentPage.value
  let bestVisibleHeight = -1
  let bestDistance = Number.POSITIVE_INFINITY

  const candidates = nearbyPages.size > 0
    ? [...nearbyPages].map((pageNumber) => pageState(pageNumber)).filter(Boolean)
    : pages.value

  for (const page of candidates) {
    const element = pageElements.get(page.number)

    if (!element) {
      continue
    }

    const rect = element.getBoundingClientRect()
    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, containerRect.bottom) -
        Math.max(rect.top, containerRect.top),
    )
    const distance = Math.abs(rect.top - containerRect.top)

    if (
      visibleHeight > bestVisibleHeight ||
      (visibleHeight === bestVisibleHeight && distance < bestDistance)
    ) {
      bestPage = page.number
      bestVisibleHeight = visibleHeight
      bestDistance = distance
    }
  }

  if (bestPage !== currentPage.value) {
    updateState({ currentPage: bestPage })
    scrollThumbnailIntoView(bestPage)
    queueThumbnails([bestPage])
  }
}

const rememberScrollPosition = () => {
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame)
  }

  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null

    if (!scrollElement.value) {
      return
    }

    updateCurrentPageFromScroll()
    updateState({
      scrollTop: scrollElement.value.scrollTop,
      scrollLeft: scrollElement.value.scrollLeft,
    })
  })
}

const scrollToPage = async (pageNumber, behavior = 'smooth') => {
  if (!ready.value) {
    return
  }

  const nextPage = Math.max(1, Math.min(pageNumber, pageCount.value))
  updateState({ currentPage: nextPage })
  await nextTick()
  const element = pageElements.get(nextPage)

  if (element && scrollElement.value) {
    scrollElement.value.scrollTo({
      top: Math.max(0, element.offsetTop - PAGE_GAP),
      left: Math.max(0, element.offsetLeft - PAGE_PADDING),
      behavior,
    })
  }

  queueMainPages([nextPage - 1, nextPage, nextPage + 1])
  scrollThumbnailIntoView(nextPage)
}

const restoreView = async () => {
  if (!scrollElement.value || pages.value.length === 0) {
    return
  }

  restoringView = true
  await nextTick()
  const savedScrollTop = props.tab.scrollTop || 0
  const savedScrollLeft = props.tab.scrollLeft || 0

  if (savedScrollTop > 0 || currentPage.value === 1) {
    scrollElement.value.scrollTop = savedScrollTop
    scrollElement.value.scrollLeft = savedScrollLeft
  } else {
    const element = pageElements.get(currentPage.value)
    scrollElement.value.scrollTop = Math.max(0, (element?.offsetTop || 0) - PAGE_GAP)
    scrollElement.value.scrollLeft = Math.max(0, (element?.offsetLeft || 0) - PAGE_PADDING)
  }

  restoringView = false
  queueMainPages([
    ...nearbyPages,
    currentPage.value - 1,
    currentPage.value,
    currentPage.value + 1,
  ])
  queueThumbnails([...nearbyThumbnails, currentPage.value])
  scrollThumbnailIntoView(currentPage.value)
}

const applyScale = async ({ restore = false } = {}) => {
  if (!ready.value) {
    return
  }

  const nextScale = calculateScale()

  if (Math.abs(displayScale.value - nextScale) > 0.001) {
    displayScale.value = nextScale
    mainGeneration += 1
    mainRenderQueue = []

    for (const task of mainRenderTasks.values()) {
      task.cancel()
    }

    mainRenderTasks.clear()

    for (const page of pages.value) {
      clearCanvas(canvasElements.get(page.number))
      page.rendering = false
      page.renderedScale = null
    }
  }

  if (Math.abs((props.tab.zoom || 1) - nextScale) > 0.001) {
    updateState({ zoom: nextScale })
  }

  await nextTick()

  if (restore) {
    await restoreView()
  } else {
    await scrollToPage(currentPage.value, 'auto')
  }
}

const loadDocument = async () => {
  if (
    !mounted ||
    loaded.value ||
    documentLoading.value ||
    props.tab.loading ||
    props.tab.error ||
    !sourceUrl.value
  ) {
    return
  }

  documentLoading.value = true
  errorMessage.value = ''
  loadingTask = getDocument({
    url: sourceUrl.value,
    rangeChunkSize: 64 * 1024,
  })

  try {
    pdfDocument = await loadingTask.promise
    const firstPage = await pdfDocument.getPage(1)
    const firstViewport = firstPage.getViewport({ scale: 1 })
    firstPageSize = {
      width: firstViewport.width,
      height: firstViewport.height,
    }
    const nextPage = Math.max(
      1,
      Math.min(props.tab.currentPage || 1, pdfDocument.numPages),
    )

    pages.value = Array.from({ length: pdfDocument.numPages }, (_, index) => ({
      number: index + 1,
      baseWidth: firstViewport.width,
      baseHeight: firstViewport.height,
      rendering: false,
      renderedScale: null,
      thumbnailRendering: false,
      thumbnailRendered: false,
      error: '',
    }))
    loaded.value = true
    documentLoading.value = false
    updateState({
      currentPage: nextPage,
      pageCount: pdfDocument.numPages,
      thumbnailsOpen: thumbnailsOpen.value,
    })
    await nextTick()
    createMainObserver()
    createThumbnailObserver()
    await applyScale({ restore: true })
  } catch (error) {
    if (mounted) {
      errorMessage.value = describeLoadError(error)
    }
  } finally {
    documentLoading.value = false
  }
}

const destroyDocument = async () => {
  clearRenderedPages()
  mainObserver?.disconnect()
  thumbnailObserver?.disconnect()
  nearbyPages.clear()
  nearbyThumbnails.clear()
  const task = loadingTask
  const documentToDestroy = pdfDocument
  loadingTask = null
  pdfDocument = null
  firstPageSize = null

  if (task) {
    await task.destroy().catch(() => {})
  } else if (documentToDestroy) {
    await documentToDestroy.destroy().catch(() => {})
  }

  pages.value = []
  loaded.value = false
}

const retry = async () => {
  if (props.tab.error || !sourceUrl.value) {
    emit('prepare-retry', props.tab.id)
    return
  }

  await destroyDocument()
  errorMessage.value = ''
  await loadDocument()
}

const zoomBy = (delta) => {
  if (!ready.value) {
    return
  }

  const nextZoom = Math.max(
    0.25,
    Math.min(4, Math.round((displayScale.value + delta) * 100) / 100),
  )
  updateState({ zoomMode: 'custom', zoom: nextZoom })
}

const setFitMode = (zoomMode) => {
  if (!ready.value) {
    return
  }

  if (props.tab.zoomMode === zoomMode) {
    applyScale()
  } else {
    updateState({ zoomMode })
  }
}

const toggleThumbnails = () => {
  updateState({ thumbnailsOpen: !thumbnailsOpen.value })
}

const toggleFullscreen = async () => {
  if (!document.fullscreenElement) {
    await viewerElement.value?.requestFullscreen?.()
    return
  }

  if (document.fullscreenElement === viewerElement.value) {
    await document.exitFullscreen?.()
  }
}

const syncFullscreen = () => {
  isFullscreen.value = document.fullscreenElement === viewerElement.value
}

const focusViewer = () => {
  viewerElement.value?.focus({ preventScroll: true })
}

const handleKeydown = (event) => {
  if (!props.visible || event.altKey) {
    return
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomBy(0.25)
    } else if (event.key === '-') {
      event.preventDefault()
      zoomBy(-0.25)
    }

    return
  }

  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    return
  }

  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault()
    scrollToPage(currentPage.value - 1)
  } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault()
    scrollToPage(currentPage.value + 1)
  }
}

watch(
  () => props.visible,
  async (visible) => {
    if (!mounted) {
      return
    }

    if (!visible) {
      clearRenderedPages()
      return
    }

    if (!loaded.value) {
      await loadDocument()
    } else {
      await nextTick()
      createMainObserver()
      createThumbnailObserver()
      await restoreView()
    }
  },
)

watch(
  () => [sourceUrl.value, props.tab.loading, props.tab.error],
  async ([url, loading, error]) => {
    if (mounted && props.visible && url && !loading && !error && !loaded.value) {
      await loadDocument()
    }
  },
)

watch(
  () => [
    props.tab.zoomMode,
    props.tab.zoomMode === 'custom' ? props.tab.zoom : null,
  ],
  () => {
    if (mounted && props.visible && loaded.value) {
      applyScale()
    }
  },
)

watch(
  () => props.tab.thumbnailsOpen,
  (open, previous) => {
    if (!mounted || !props.visible || !loaded.value || open === previous) {
      return
    }

    if (!thumbnailsOpen.value) {
      thumbnailObserver?.disconnect()
      nearbyThumbnails.clear()
      thumbnailGeneration += 1
      thumbnailRenderQueue = []

      for (const page of pages.value) {
        clearThumbnail(page.number)
      }

      return
    }

    nextTick(() => {
      createThumbnailObserver()
      queueThumbnails([currentPage.value])
      scrollThumbnailIntoView(currentPage.value)
    })
  },
)

onMounted(() => {
  mounted = true
  resizeObserver = new ResizeObserver(() => {
    if (!props.visible || !loaded.value) {
      return
    }

    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame)
    }

    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null

      if (['fit-width', 'fit-page'].includes(props.tab.zoomMode)) {
        applyScale()
      }
    })
  })
  resizeObserver.observe(scrollElement.value)
  document.addEventListener('fullscreenchange', syncFullscreen)

  if (props.visible) {
    loadDocument()
  }
})

onBeforeUnmount(() => {
  mounted = false
  resizeObserver?.disconnect()
  mainObserver?.disconnect()
  thumbnailObserver?.disconnect()
  document.removeEventListener('fullscreenchange', syncFullscreen)

  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame)
  }

  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame)
  }

  destroyDocument()
})
</script>

<template>
  <section
    ref="viewerElement"
    class="pdf-viewer"
    :aria-label="`PDF viewer for ${tab.fileName}`"
    tabindex="0"
    @keydown="handleKeydown"
  >
    <div class="pdf-toolbar" aria-label="PDF controls">
      <button
        class="btn btn-sm toolbar-button toolbar-toggle pdf-toolbar-icon"
        :class="{ 'is-active': thumbnailsOpen }"
        type="button"
        title="Show or hide page thumbnails"
        aria-label="Show or hide page thumbnails"
        :aria-pressed="thumbnailsOpen"
        :disabled="!ready"
        @click="toggleThumbnails"
      >
        <i class="mdi mdi-dock-left" aria-hidden="true" />
      </button>

      <span class="pdf-toolbar-divider" aria-hidden="true" />

      <div class="pdf-toolbar-group">
        <button
          class="btn btn-sm toolbar-button toolbar-command pdf-toolbar-icon"
          type="button"
          title="Previous page (Left arrow or Page Up)"
          aria-label="Previous page"
          :disabled="!canGoPrevious"
          @click="scrollToPage(currentPage - 1)"
        >
          <i class="mdi mdi-chevron-left" aria-hidden="true" />
        </button>
        <span class="pdf-page-indicator" aria-live="polite">
          {{ currentPage }} / {{ pageCount || '—' }}
        </span>
        <button
          class="btn btn-sm toolbar-button toolbar-command pdf-toolbar-icon"
          type="button"
          title="Next page (Right arrow or Page Down)"
          aria-label="Next page"
          :disabled="!canGoNext"
          @click="scrollToPage(currentPage + 1)"
        >
          <i class="mdi mdi-chevron-right" aria-hidden="true" />
        </button>
      </div>

      <span class="pdf-toolbar-divider" aria-hidden="true" />

      <div class="pdf-toolbar-group">
        <button
          class="btn btn-sm toolbar-button toolbar-command pdf-toolbar-icon"
          type="button"
          title="Zoom out (Cmd/Ctrl+-)"
          aria-label="Zoom out"
          :disabled="!ready || displayScale <= 0.25"
          @click="zoomBy(-0.25)"
        >
          <i class="mdi mdi-minus" aria-hidden="true" />
        </button>
        <span class="pdf-zoom-value">{{ zoomLabel }}</span>
        <button
          class="btn btn-sm toolbar-button toolbar-command pdf-toolbar-icon"
          type="button"
          title="Zoom in (Cmd/Ctrl++)"
          aria-label="Zoom in"
          :disabled="!ready || displayScale >= 4"
          @click="zoomBy(0.25)"
        >
          <i class="mdi mdi-plus" aria-hidden="true" />
        </button>
      </div>

      <span class="pdf-toolbar-divider" aria-hidden="true" />

      <div class="pdf-toolbar-group">
        <button
          class="btn btn-sm toolbar-button toolbar-toggle"
          :class="{ 'is-active': tab.zoomMode === 'fit-width' }"
          type="button"
          :aria-pressed="tab.zoomMode === 'fit-width'"
          :disabled="!ready"
          @click="setFitMode('fit-width')"
        >
          Fit Width
        </button>
        <button
          class="btn btn-sm toolbar-button toolbar-toggle"
          :class="{ 'is-active': tab.zoomMode === 'fit-page' }"
          type="button"
          :aria-pressed="tab.zoomMode === 'fit-page'"
          :disabled="!ready"
          @click="setFitMode('fit-page')"
        >
          Fit Page
        </button>
      </div>

      <span class="pdf-toolbar-spacer" />

      <button
        class="btn btn-sm toolbar-button toolbar-command pdf-toolbar-icon"
        type="button"
        :title="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
        :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
        @click="toggleFullscreen"
      >
        <i
          class="mdi"
          :class="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
          aria-hidden="true"
        />
      </button>
    </div>

    <div class="pdf-content">
      <aside
        v-if="loaded && thumbnailsOpen"
        ref="thumbnailElement"
        class="pdf-thumbnail-sidebar"
        aria-label="Page thumbnails"
      >
        <div class="pdf-thumbnail-list">
          <button
            v-for="page in pages"
            :key="`thumbnail-${page.number}`"
            :ref="(element) => setThumbnailElement(element, page.number)"
            class="pdf-thumbnail-button"
            :class="{ 'is-active': page.number === currentPage }"
            type="button"
            :data-page-number="page.number"
            :aria-current="page.number === currentPage ? 'page' : undefined"
            :aria-label="`Go to page ${page.number}`"
            @click="scrollToPage(page.number)"
          >
            <span class="pdf-thumbnail-frame" :style="thumbnailFrameStyle(page)">
              <canvas
                :ref="(element) => setThumbnailCanvasElement(element, page.number)"
                class="pdf-thumbnail-canvas"
                width="0"
                height="0"
                aria-hidden="true"
              />
              <span
                v-if="!page.thumbnailRendered"
                class="pdf-thumbnail-placeholder"
                aria-hidden="true"
              >
                <span
                  v-if="page.thumbnailRendering"
                  class="spinner-border spinner-border-sm"
                />
              </span>
            </span>
            <span class="pdf-thumbnail-number">{{ page.number }}</span>
          </button>
        </div>
      </aside>

      <div
        ref="scrollElement"
        class="pdf-document-area"
        @pointerdown="focusViewer"
        @scroll.passive="rememberScrollPosition"
      >
        <div v-if="tab.loading" class="pdf-viewer-message">
          <span class="spinner-border spinner-border-sm" aria-hidden="true" />
          {{ tab.statusMessage || 'Preparing file…' }}
        </div>

        <div v-else-if="tab.error" class="pdf-viewer-message text-danger" role="alert">
          <i class="mdi mdi-alert-outline" aria-hidden="true" />
          <span>{{ tab.error.message }}</span>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="retry">
            Retry
          </button>
        </div>

        <div v-else-if="documentLoading" class="pdf-viewer-message">
          <span class="spinner-border spinner-border-sm" aria-hidden="true" />
          Loading document…
        </div>

        <div v-else-if="errorMessage" class="pdf-viewer-message text-danger" role="alert">
          <i class="mdi mdi-alert-outline" aria-hidden="true" />
          <span>{{ errorMessage }}</span>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="retry">
            Retry
          </button>
        </div>

        <div v-else-if="loaded" class="pdf-pages">
          <article
            v-for="page in pages"
            :key="`page-${page.number}`"
            :ref="(element) => setPageElement(element, page.number)"
            class="pdf-page-shell"
            :class="{ 'is-current': page.number === currentPage }"
            :data-page-number="page.number"
            :aria-label="`Page ${page.number} of ${pageCount}`"
            :aria-current="page.number === currentPage ? 'page' : undefined"
          >
            <div class="pdf-page-frame" :style="pageFrameStyle(page)">
              <canvas
                :ref="(element) => setCanvasElement(element, page.number)"
                class="pdf-page-canvas"
                width="0"
                height="0"
                aria-hidden="true"
              />
              <div
                v-if="page.renderedScale === null && !page.error"
                class="pdf-page-placeholder"
                aria-hidden="true"
              >
                <span
                  v-if="page.rendering"
                  class="spinner-border spinner-border-sm"
                />
              </div>
              <div v-if="page.error" class="pdf-page-error" role="alert">
                <i class="mdi mdi-alert-outline" aria-hidden="true" />
                {{ page.error }}
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
