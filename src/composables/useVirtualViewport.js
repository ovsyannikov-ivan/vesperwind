import { reactive } from 'vue'
import { scrollTopForIndex } from '../utils/virtualRange.js'

const DEFAULT_ROW_HEIGHT = 22

const scrollParentOf = (element) => {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * Tracks the scroll container a virtual list lives in. Scroll position is read
 * at most once per animation frame (or from the scroll event when frames are
 * paused); offsets and the sticky header are measured only on attach and
 * resize, never per scroll event.
 */
export const createVirtualViewport = ({ stickySelector = '.tree-columns-header' } = {}) => {
  const viewport = reactive({ scrollTop: 0, height: 0, offset: 0, inset: 0, rowHeight: DEFAULT_ROW_HEIGHT })
  let scrollElement = null
  let listElement = null
  let frame = 0
  let fallback = 0
  let observer = null

  const readScroll = () => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    clearTimeout(fallback)
    frame = 0
    fallback = 0
    if (scrollElement) viewport.scrollTop = scrollElement.scrollTop
  }
  // One update per frame; a timer covers windows that get no frames.
  const onScroll = () => {
    if (frame || fallback) return
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(readScroll)
    fallback = setTimeout(readScroll, 100)
  }
  const measure = () => {
    // A hidden list (search results shown instead) keeps its last geometry.
    if (!scrollElement || !listElement || !listElement.getClientRects().length) return
    const scrollBox = scrollElement.getBoundingClientRect()
    const listBox = listElement.getBoundingClientRect()
    viewport.offset = listBox.top - scrollBox.top + scrollElement.scrollTop
    viewport.height = scrollElement.clientHeight
    viewport.scrollTop = scrollElement.scrollTop
    const sticky = stickySelector ? scrollElement.querySelector(stickySelector) : null
    viewport.inset = sticky && getComputedStyle(sticky).position === 'sticky' ? sticky.offsetHeight : 0
    const height = parseFloat(getComputedStyle(listElement).getPropertyValue('--file-tree-row-height'))
    viewport.rowHeight = height > 0 ? height : DEFAULT_ROW_HEIGHT
  }

  const attach = (list) => {
    detach()
    listElement = list
    scrollElement = scrollParentOf(list)
    if (!scrollElement) return
    scrollElement.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(scrollElement)
    }
    measure()
  }
  const detach = () => {
    scrollElement?.removeEventListener('scroll', onScroll)
    observer?.disconnect()
    observer = null
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    clearTimeout(fallback)
    frame = 0
    fallback = 0
    scrollElement = null
    listElement = null
  }

  /** Bring row `index` into view (by position, mounted or not). */
  const scrollToIndex = (index, block = 'nearest') => {
    if (!scrollElement || index < 0) return false
    const top = scrollTopForIndex({ index, rowHeight: viewport.rowHeight, scrollTop: scrollElement.scrollTop,
      viewportHeight: scrollElement.clientHeight, offset: viewport.offset, inset: viewport.inset, block })
    if (top !== null) scrollElement.scrollTop = top
    viewport.scrollTop = scrollElement.scrollTop
    return true
  }

  return { viewport, attach, detach, measure, scrollToIndex, scrollElement: () => scrollElement }
}
