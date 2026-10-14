// Main preview scrollports, including viewers that scroll inside modal-body.
const previewScrollports = '.file-preview-text, .pdf-document-area, .spreadsheet-preview-scroll, '
  + '[data-testid="docx-editor-scroll"], .markdown-preview, .quick-look-metadata'

export const scrollEdges = ({ scrollTop, scrollHeight, clientHeight }) => {
  const maximum = Math.max(0, scrollHeight - clientHeight)
  const position = Math.max(0, Math.min(maximum, scrollTop))
  return {
    top: clientHeight > 0 && position > 1,
    bottom: clientHeight > 0 && maximum - position > 1,
  }
}

export const observeScrollShadows = (root, update, {
  ResizeObserver = globalThis.ResizeObserver,
  MutationObserver = globalThis.MutationObserver,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  computedStyle = (element) => globalThis.getComputedStyle(element),
} = {}) => {
  let frame = null
  let stopped = false
  let observed = new Set()
  const schedule = () => {
    if (!stopped && frame === null) frame = requestFrame(measure)
  }
  const resize = new ResizeObserver(schedule)
  const mutation = new MutationObserver(schedule)
  const measure = () => {
    frame = null
    if (stopped) return
    const ports = [root, ...root.querySelectorAll(previewScrollports)]
      .filter((element) => /^(auto|scroll)$/.test(computedStyle(element).overflowY))
    // Watching content as well as the viewport catches growth after async
    // rendering, font/image loading, zoom and switching spreadsheet sheets.
    const nextObserved = new Set([root, ...ports, ...ports.flatMap((element) => [...element.children])])
    for (const element of observed) if (!nextObserved.has(element)) resize.unobserve(element)
    for (const element of nextObserved) if (!observed.has(element)) resize.observe(element)
    observed = nextObserved
    const port = ports.filter((element) => element.clientHeight > 0 && element.clientWidth > 0)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
    if (!port) { update({ top: false, bottom: false, style: {} }); return }
    const bounds = root.getBoundingClientRect()
    const viewport = port.getBoundingClientRect()
    const left = Math.max(0, viewport.left - bounds.left + port.clientLeft)
    const top = Math.max(0, viewport.top - bounds.top + port.clientTop)
    const width = Math.max(0, Math.min(port.clientWidth, root.clientWidth - left))
    const height = Math.max(0, Math.min(port.clientHeight, root.clientHeight - top))
    update({ ...scrollEdges(port), style: {
      left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
    } })
  }
  root.addEventListener('scroll', schedule, { capture: true, passive: true })
  mutation.observe(root, { childList: true, subtree: true, characterData: true })
  schedule()
  return () => {
    stopped = true
    if (frame !== null) cancelFrame(frame)
    root.removeEventListener('scroll', schedule, true)
    resize.disconnect()
    mutation.disconnect()
  }
}
