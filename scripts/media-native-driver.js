// Injected only by --media-ui-regression into the actual application WebViews.
(async () => {
  if (window.__MEDIA_PROBE_RUNNING__) return
  window.__MEDIA_PROBE_RUNNING__ = true
  const { endpoint, label, pid } = window.__MEDIA_PROBE_CONFIG__
  const post = (route, value) => fetch(`${endpoint}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const opens = []
  // Opt-in test clock only: an occluded executor cannot deliver animation frames.
  // Physical foreground/manual acceptance must run without this flag.
  if (window.__MEDIA_PROBE_CONFIG__.allowHiddenFrames && document.hidden) {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 16)
    window.cancelAnimationFrame = handle => window.clearTimeout(handle)
  }
  const inspect = () => ({ visibility: document.visibilityState, width: innerWidth, height: innerHeight,
    surfaces: [...document.querySelectorAll('.native-mpv-surface, .media-viewer-stage, .modal')].map(e => ({ tag: e.className, box: e.getBoundingClientRect().toJSON(), display: getComputedStyle(e).display })),
    errors: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent.trim()), panels: label === 'main' ? panels() : [] })
  window.addEventListener('error', e => void post('trace', { label, stage: 'ui.error', message: e.message }))
  window.addEventListener('unhandledrejection', e => void post('trace', { label, stage: 'ui.rejection', message: String(e.reason) }))
  window.__VESPERWIND_MEDIA_TRACE__ = value => {
    if (value.stage === 'player.open') opens.push(value)
    void post('trace', { label, ...value }).catch(() => {})
  }
  const invoke = (command, payload = {}) => window.__TAURI_INTERNALS__.invoke(command, { payload })
  const wait = async (check, timeout = 45000) => {
    const until = performance.now() + timeout
    while (performance.now() < until) { const result = await check(); if (result) return result; await sleep(50) }
    throw Error(`Timed out in ${label}: ${check.toString()}`)
  }
  const pointer = (element, type, extra = {}) => element.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', bubbles: type !== 'pointerenter' && type !== 'pointerleave', ...extra }))
  const panels = () => [...document.querySelectorAll('.file-panel')].map(panel => ({
    side: panel.getAttribute('aria-label'), path: panel.querySelector('.path-segment[aria-current="location"]')?.title,
    rows: panel.querySelectorAll('.tree-row[data-file-path]').length,
    empty: [...panel.querySelectorAll('.tree-state')].some(e => e.textContent.trim() === 'Empty folder'),
    error: panel.querySelector('.tree-error')?.textContent.trim() || null,
  }))
  const audioState = async path => {
    const open = [...opens].reverse().find(item => item.kind === 'audio' && item.path === path)
    if (!open) return null
    const response = await invoke('player_snapshot', { sessionId: open.sessionId })
    return response.ok && response.state?.duration > 0 ? { ...open, state: response.state } : null
  }
  const navigate = async ({ path, side = 'left' }) => {
    const panel = await wait(() => document.querySelector(`[aria-label="${side} file panel"]`))
    const edit = await wait(() => panel.querySelector(`button[aria-label="Edit ${side} panel path"]`))
    edit.click()
    const input = await wait(() => panel.querySelector(`input[aria-label="${side} panel full path"]`))
    input.value = path; input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wait(() => panel.querySelector('.path-segment[aria-current="location"]')?.title === path)
    await wait(() => panel.querySelector('.tree-row[data-file-path]'))
    return panels()
  }
  const open = async ({ path, gesture = 'doubleclick' }) => {
    const row = await wait(() => [...document.querySelectorAll('[aria-label="left file panel"] .tree-row')].find(e => e.dataset.filePath === path))
    pointer(row, 'pointerdown'); row.click(); row.focus(); await sleep(60)
    if (gesture === 'Space') row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
    else if (gesture === 'View') {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }))
      const view = await wait(() => [...document.querySelectorAll('.file-entry-context-menu .dropdown-item')].find(e => e.textContent.trim() === 'View'))
      view.click()
    } else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    return { panels: panels() }
  }
  const thumbnail = async () => {
    const controls = await wait(() => document.querySelector('.media-overlay-controls'))
    await wait(async () => {
      const response = await invoke('player_overlay_snapshot')
      const id = response.context?.sessionId
      if (!id) return false
      const snapshot = await invoke('player_snapshot', { sessionId: id })
      return snapshot.state?.status === 'playing' && snapshot.state.duration > 0
    })
    pointer(controls, 'pointerenter'); await sleep(5100)
    const root = document.querySelector('.media-overlay')
    if (controls.classList.contains('is-hidden') || root.classList.contains('is-cursor-hidden')) throw Error('Controls/cursor hid while hovered')
    const seek = controls.querySelector('input[aria-label="Playback position"]')
    const rect = seek.getBoundingClientRect()
    const image = async ratio => {
      const begin = performance.now()
      pointer(seek, 'pointermove', { clientX: rect.left + rect.width * ratio, clientY: rect.top + rect.height / 2 })
      await sleep(25)
      if (!controls.querySelector('.video-thumbnail-time')) throw Error('Timestamp was not immediate')
      if (controls.querySelector('.video-thumbnail-preview img')) throw Error('Old/cached image bypassed dwell')
      const img = await wait(() => {
        const node = controls.querySelector('.video-thumbnail-preview img')
        return node?.complete && node.naturalWidth > 0 && node
      })
      await sleep(220)
      const box = img.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (!img.src.startsWith('data:image/jpeg;base64,') || !box.width || box.top < 0 || !img.parentElement.contains(hit)) throw Error('Ready image is clipped or covered')
      return { elapsedMs: performance.now() - begin, width: img.naturalWidth, urlLength: img.src.length, ratio }
    }
    const first = await image(.2); const second = await image(.6)
    await sleep(5100)
    if (controls.classList.contains('is-hidden')) throw Error('Seek controls hid under stationary pointer')
    pointer(controls, 'pointerleave'); await sleep(2900)
    if (!controls.classList.contains('is-hidden')) throw Error('Leaving did not restore auto-hide')
    pointer(controls, 'pointerenter')
    return { first, second, controlsStayedVisible: true, cursorStayedVisible: true }
  }
  // Playback diagnostics plus the rendered Info panel, once the Dolby Vision
  // source probe (if any) has resolved.
  const videoInfo = async ({ timeout = 45000, settleMs = 5000 } = {}) => {
    const ready = async () => {
      const id = (await invoke('player_overlay_snapshot')).context?.sessionId
      const snapshot = id && await invoke('player_snapshot', { sessionId: id })
      const diagnostics = snapshot?.state?.diagnostics
      if (snapshot?.state?.status !== 'playing' || !diagnostics) return false
      const dv = diagnostics.dolbyVision
      return (!diagnostics.dolbyVisionProfile || (dv?.rpuProcessingActive != null && !/only/.test(dv.evidence))) && snapshot.state
    }
    await wait(ready, timeout)
    // Output negotiation settles after the first frames; read it afterwards.
    await sleep(settleMs)
    const state = await wait(ready, timeout)
    const toggle = await wait(() => document.querySelector('.media-overlay-info-toggle'))
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
    const panel = await wait(() => document.querySelector('.media-overlay-info'))
    await sleep(300)
    const sections = [...panel.querySelectorAll('section')].map(section => ({
      title: section.querySelector('h2')?.textContent.trim(),
      rows: [...section.querySelectorAll('dl > div')].map(row => ({
        label: row.querySelector('dt')?.textContent.trim(),
        value: row.querySelector('dd')?.textContent.trim(),
        title: row.querySelector('dd')?.title || undefined,
      })),
    }))
    return { diagnostics: state.diagnostics, sections }
  }
  const actions = {
    navigate, open, thumbnail, inspect, videoInfo,
    panels: () => panels(),
    waitClosedVideo: async () => { await wait(() => !document.body.classList.contains('modal-open')); return true },
    closeVideo: () => { document.querySelector('.media-overlay-header button[title="Close"], .media-overlay-header button[aria-label="Close"]')?.click(); return true },
    audio: async ({ path, quick = false }) => {
      const selector = quick ? '.quick-look-modal' : '.audio-player-bar'
      const states = []
      const state = await wait(async () => {
        const element = document.querySelector(selector)
        const message = element?.querySelector('[role="status"]')?.textContent.trim() || element?.textContent.includes('Preparing file…') && 'Preparing file…'
        if (message && states.at(-1) !== message) states.push(message)
        return element?.querySelector('input[aria-label="Playback position"]') && await audioState(path)
      })
      return { ...state, preparationMessages: states, panels: panels() }
    },
    seekPauseAudio: async ({ path, seconds }) => {
      const bar = document.querySelector('.audio-player-bar')
      const seek = bar.querySelector('input[aria-label="Playback position"]')
      seek.value = seconds; seek.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(async () => (await audioState(path))?.state.currentTime >= seconds - 1)
      bar.querySelector('button[aria-label="Pause"]')?.click(); await sleep(250)
      return audioState(path)
    },
    closeQuick: async () => { document.querySelector('.quick-look-modal button[aria-label="Close Quick Look"]')?.click(); await sleep(300); return true },
    closeAudio: async () => { document.querySelector('button[aria-label="Close audio player"]')?.click(); await sleep(300); return true },
    quit: () => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'media-ui-regression:quit', payload: null }),
  }
  await post('ready', { label, pid })
  for (;;) {
    let command
    try { command = await (await fetch(`${endpoint}/next/${label}`)).json() } catch { await sleep(100); continue }
    if (!command) { await sleep(100); continue }
    try { await post('result', { id: command.id, label, result: await actions[command.action](command.args || {}) }) }
    catch (error) { await post('result', { id: command.id, label, error: `${error.message || String(error)}\n${error.stack || ''}`, panels: label === 'main' ? panels() : null }) }
  }
})().catch(error => console.error('Native media driver failed', error))
