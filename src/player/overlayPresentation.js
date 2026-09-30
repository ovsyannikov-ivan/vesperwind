// An IPC resize acknowledgement is earlier than the resized WebView's paint.
// Keep the cover opaque until its viewport reaches the requested size and has
// survived two animation frames, including reduced-motion transitions.
export const waitForOverlayPresentation = async ({
  viewport,
  measure = () => ({ width: window.innerWidth, height: window.innerHeight }),
  frame = () => new Promise(requestAnimationFrame),
  now = () => performance.now(),
  timeout = 750,
}) => {
  const deadline = now() + timeout
  let paintedFrames = 0
  while (paintedFrames < 2) {
    await frame()
    const size = measure()
    const ready = !viewport || (
      size.width >= viewport.width - 1 && size.height >= viewport.height - 1
    )
    paintedFrames = ready ? paintedFrames + 1 : 0
    if (now() >= deadline && paintedFrames < 2) {
      throw new Error('Media overlay did not present the resized cover')
    }
  }
}
