// A slow native resize must not accumulate a request for every browser frame.
export const createLayoutQueue = ({ apply, onError = () => {} }) => {
  let pending = null
  let running = null
  let appliedKey = null
  const request = (layout) => {
    pending = layout
    if (!running) {
      running = Promise.resolve().then(async () => {
        while (pending) {
          const next = pending
          pending = null
          const key = JSON.stringify(next)
          if (key === appliedKey) continue
          try {
            await apply(next)
            appliedKey = key
          } catch (error) { onError(error) }
        }
      }).finally(() => { running = null })
    }
    return running
  }
  return { request, flush: () => running || Promise.resolve(), cancel: () => { pending = null } }
}
