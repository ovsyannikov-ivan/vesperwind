// Opt-in diagnostics for native acceptance; ordinary playback emits no trace.
export const traceMedia = (stage, details = {}) => {
  try { globalThis.__VESPERWIND_MEDIA_TRACE__?.({ stage, at: performance.now(), ...details }) } catch {}
}
