// The cover must never outlive a failed or interrupted native transition.
export const createOverlayTransitionHandler = ({
  paint, reset, acknowledge, timeout = 8000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) => {
  let generation = 0
  let timer
  let pendingId
  const clear = () => { clearTimer(timer); timer = undefined }
  const acknowledgePending = (error) => {
    if (!pendingId) return
    const id = pendingId
    pendingId = undefined
    void acknowledge(id, error)
  }
  const resetCover = () => {
    generation += 1
    clear()
    reset()
  }
  const handle = async (request) => {
    acknowledgePending('Media transition was superseded')
    const current = ++generation
    pendingId = request.id
    clear()
    timer = setTimer(() => {
      resetCover()
      acknowledgePending('Media transition cover timed out')
    }, timeout)
    try {
      await paint(request)
      if (current !== generation) return
      acknowledgePending()
      if (!request.covered) clear()
    } catch (error) {
      if (current !== generation) return
      resetCover()
      acknowledgePending(error.message)
    }
  }
  return {
    handle,
    dispose: () => {
      resetCover()
      acknowledgePending('Media overlay was closed')
    },
  }
}
