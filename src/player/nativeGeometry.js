// Bootstrap can still be display:none when the async backend selection ends.
// Starting an owned VO with that 0x0 host fails before ResizeObserver is attached.
export const waitForNativeGeometry = async ({
  measure, cancelled = () => false,
  frame = () => new Promise(requestAnimationFrame),
  now = () => performance.now(), timeout = 2000,
}) => {
  const deadline = now() + timeout
  let previous = null
  while (!cancelled()) {
    let timer
    try {
      // Occluded WKWebViews may suspend animation frames. The startup deadline
      // must still expire, allowing close/reopen to cancel the pending load.
      await Promise.race([frame(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native video viewport did not become visible')), Math.max(0, deadline - now()))
      })])
    } finally { clearTimeout(timer) }
    if (cancelled()) return null
    const bounds = measure()
    if (bounds?.width > 1 && bounds?.height > 1) {
      if (previous && ['x', 'y', 'width', 'height', 'scaleFactor'].every(
        (key) => bounds[key] === previous[key],
      )) return bounds
      previous = bounds
    } else previous = null
    if (now() >= deadline) throw new Error('Native video viewport did not become visible')
  }
  return null
}
