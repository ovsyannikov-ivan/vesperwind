// Keep the native resize behind a cover, and always uncover after a failure.
export const runFullscreenTransition = async ({ cover, change, settle, reveal, timeout = 8000 }) => {
  const step = async (name, operation) => {
    let timer
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Media transition ${name} timed out`)), timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await step('cover', cover)
    await step('resize', change)
    await step('layout', settle)
    // Native window animation and compositor updates stay hidden for a fixed
    // interval on every platform. Do not gate the UX on video frame counters.
    await step('cover-delay', () => new Promise((resolve) => setTimeout(resolve, 500)))
  } finally {
    await step('reveal', reveal)
  }
}
