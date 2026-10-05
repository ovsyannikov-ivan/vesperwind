// This page has no Tauri IPC or application UI. Its only communication is the
// private origin's closed route table, bound to the owning engine generation.
const base = new URL('./', location.href)
const start = performance.now()
const post = async (route, body) => {
  const response = await fetch(new URL(route, base), { method: 'POST', body })
  if (!response.ok) throw new Error(`Converter origin rejected ${route}: ${response.status}`)
}
let currentId = null
const fail = async (error) => {
  await post(currentId ? `failure/${currentId}` : 'fatal', String(error?.stack || error)).catch(() => {})
}
addEventListener('error', (event) => { void fail(event.message) })
addEventListener('unhandledrejection', (event) => { void fail(event.reason) })
await post('diagnostic', JSON.stringify({ phase: 'boot', secure: isSecureContext, isolated: crossOriginIsolated }))
const { ZetaHelperMain } = await import('./vendor/zetaHelper.js')
const helper = new ZetaHelperMain('office_thread.js', { threadJsType: 'module', wasmPkg: `url:${base.href}`, blockPageScroll: false })
helper.Module.arguments = ['--headless', '--nologo', '--nodefault', '--norestore']
let font = new Uint8Array(await (await fetch(new URL('font/NotoSansCJKjp-Regular.otf', base))).arrayBuffer())
helper.Module.preRun = [() => {
  globalThis.FS.mkdirTree('/instdir/share/fonts/truetype')
  globalThis.FS.writeFile('/instdir/share/fonts/truetype/NotoSansCJKjp-Regular.otf', font)
  font = null
}]
helper.Module.printErr = (message) => { void post('diagnostic', String(message).slice(0, 1500)).catch(() => {}) }
helper.Module.onAbort = (reason) => { void fail(reason) }
let pending
await new Promise((resolve) => helper.start(() => {
  helper.thrPort.onmessage = ({ data }) => {
    if (data.cmd === 'ready') resolve()
    else if (pending && data.id === pending.id) {
      const request = pending; pending = null
      if (data.cmd === 'converted') request.resolve()
      else request.reject(new Error(data.message || 'Office conversion failed'))
    }
  }
}))
await post('ready', JSON.stringify({ initMs: performance.now() - start }))
let sequence = 0
for (;;) {
  const response = await fetch(new URL('job', base))
  if (response.status === 204) { await new Promise((resolve) => setTimeout(resolve, 100)); continue }
  if (!response.ok) break // Owning generation was destroyed.
  const job = await response.json()
  currentId = job.id
  const index = ++sequence
  const from = `/tmp/input-${index}.${job.format}`, to = `/tmp/output-${index}.${job.target}`
  try {
    const input = await fetch(new URL(`input/${job.id}`, base))
    if (!input.ok) throw new Error('Expired Office request')
    helper.FS.writeFile(from, new Uint8Array(await input.arrayBuffer()))
    await new Promise((resolve, reject) => {
      pending = { id: job.id, resolve, reject }
      helper.thrPort.postMessage({ cmd: 'convert', id: job.id, from, to, target: job.target })
    })
    await post(`output/${job.id}`, helper.FS.readFile(to))
  } catch (error) {
    await fail(error)
  } finally {
    for (const file of [from, to]) { try { helper.FS.unlink(file) } catch {} }
    currentId = null
  }
}
