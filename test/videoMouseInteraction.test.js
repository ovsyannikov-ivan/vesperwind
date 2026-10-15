import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { h, nextTick, reactive } from 'vue'
import { createSeekController } from '../src/player/seekController.js'
import {
  createPlaybackToggle,
  createVideoMouseInteraction,
  videoMouseAction,
} from '../src/player/videoMouseInteraction.js'
import {
  compileComponent,
  FakeElement,
  installDomGlobals,
  testRenderer,
} from './support/vueTestRenderer.js'
import {
  players,
  mediaOverlay,
  PlayerStatus,
  overlayActions,
} from './support/videoMousePlayerStub.js'

const rect = { left: 100, top: 50, width: 1000, height: 500 }
const event = (surface, x, extra = {}) => ({
  target: surface,
  currentTarget: surface,
  clientX: x,
  clientY: 100,
  pointerId: 1,
  pointerType: 'mouse',
  isPrimary: true,
  button: 0,
  stopPropagation() {},
  preventDefault() {},
  ...extra,
})
const gesture = (mouse, surface, x, extra) => {
  mouse.down(event(surface, x, extra))
  mouse.up(event(surface, x, extra))
  mouse.click(event(surface, x, extra))
}

test('video zones classify all requested positions and exact boundaries', () => {
  for (const [percent, expected] of [
    [10, 'backward'],
    [25, 'toggle'],
    [30, 'toggle'],
    [50, 'toggle'],
    [70, 'toggle'],
    [75, 'forward'],
    [90, 'forward'],
  ])
    assert.equal(videoMouseAction(100 + percent * 10, 100, rect), expected)
  assert.equal(videoMouseAction(99, 100, rect), null)
  assert.equal(videoMouseAction(1101, 100, rect), null)
  assert.equal(videoMouseAction(500, 49, rect), null)
  assert.equal(videoMouseAction(500, 100, { ...rect, width: 0 }), null)
  assert.equal(videoMouseAction(NaN, 100, rect), null)
  assert.equal(videoMouseAction(1900, 100, { ...rect, width: 2000 }), 'forward')
})

test('rapid mouse and keyboard seeks share the original 180ms stack and clamp at both edges', () => {
  let time = 60,
    hint,
    timer,
    toggles = 0
  const seeks = []
  const seek = createSeekController({
    getTime: () => time,
    getDuration: () => 200,
    seek: (target) => seeks.push(target),
    onChange: (value) => {
      hint = value
    },
    setTimer: (callback, delay) => {
      assert.equal(delay, 180)
      timer = callback
      return callback
    },
    clearTimer: () => {
      timer = null
    },
  })
  const surface = {}
  const mouse = createVideoMouseInteraction({
    enabled: () => true,
    getRect: () => rect,
    onSeek: seek.add,
    onToggle: () => {
      toggles++
    },
  })
  for (let i = 0; i < 3; i++) gesture(mouse, surface, 200)
  assert.deepEqual(hint, { target: 30, delta: -30 })
  timer()
  assert.deepEqual(seeks, [30])
  time = 30
  for (let i = 0; i < 5; i++) gesture(mouse, surface, 1000)
  assert.deepEqual(hint, { target: 80, delta: 50 })
  // Keyboard and mouse deliberately use this same controller instance.
  seek.add(-10)
  gesture(mouse, surface, 200)
  gesture(mouse, surface, 1000)
  assert.deepEqual(hint, { target: 70, delta: 40 })
  timer()
  time = 195
  gesture(mouse, surface, 1000)
  assert.equal(hint.target, 200)
  timer()
  time = 5
  gesture(mouse, surface, 200)
  assert.equal(hint.target, 0)
  timer()
  assert.deepEqual(seeks, [30, 70, 200, 0])
  assert.equal(toggles, 0)
})

test('surface rejects secondary buttons, dragging, touch, controls and interrupted clicks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let enabled = true,
    actions = 0
  const surface = {}
  const mouse = createVideoMouseInteraction({
    enabled: () => enabled,
    getRect: () => rect,
    onSeek: () => {
      actions++
    },
    onToggle: () => {
      actions++
    },
  })
  for (const extra of [
    { button: 2 },
    { button: 1 },
    { pointerType: 'touch' },
    { isPrimary: false },
    { defaultPrevented: true },
    { target: {} },
  ])
    gesture(mouse, surface, 1000, extra)
  mouse.down(event(surface, 1000))
  mouse.move(event(surface, 1020))
  mouse.move(event(surface, 1000))
  mouse.up(event(surface, 1000))
  mouse.click(event(surface, 1000))
  mouse.down(event(surface, 1000))
  mouse.reset()
  mouse.up(event(surface, 1000))
  mouse.click(event(surface, 1000))
  mouse.click(event(surface, 1000)) // No matching mouse press.
  mouse.down(event(surface, 1000))
  enabled = false
  mouse.up(event(surface, 1000))
  mouse.click(event(surface, 1000))
  assert.equal(actions, 0)
  enabled = true
  gesture(mouse, surface, 600)
  assert.equal(actions, 0)
  t.mock.timers.tick(300)
  assert.equal(actions, 1)
})

test('middle double click toggles fullscreen without playback; seek-zone double clicks still accumulate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let enabled = true
  const surface = {},
    actions = []
  const mouse = createVideoMouseInteraction({
    enabled: () => enabled,
    getRect: () => rect,
    onSeek: (value) => actions.push(value),
    onToggle: () => actions.push('toggle'),
    onFullscreen: () => actions.push('fullscreen'),
  })
  gesture(mouse, surface, 600, { detail: 1 })
  t.mock.timers.tick(100)
  gesture(mouse, surface, 600, { detail: 2 })
  mouse.doubleClick(event(surface, 600, { detail: 2 }))
  t.mock.timers.tick(500)
  assert.deepEqual(actions, ['fullscreen'])
  gesture(mouse, surface, 1000, { detail: 1 })
  gesture(mouse, surface, 1000, { detail: 2 })
  mouse.doubleClick(event(surface, 1000, { detail: 2 }))
  assert.deepEqual(actions, ['fullscreen', 10, 10])
  gesture(mouse, surface, 600, { detail: 1 })
  mouse.cancelPress() // Leaving the surface after release doesn't lose a click.
  t.mock.timers.tick(300)
  assert.equal(actions.at(-1), 'toggle')
  gesture(mouse, surface, 600, { detail: 1 })
  mouse.reset() // Source/unmount cancel the delayed click.
  t.mock.timers.tick(500)
  assert.equal(actions.length, 4)
  gesture(mouse, surface, 600, { detail: 1 })
  enabled = false
  t.mock.timers.tick(500)
  assert.equal(actions.length, 4)
})

test('Play/Pause sends one command while a delayed update is pending and ignores old completions after reset', async () => {
  let enabled = true,
    playing = false,
    finish,
    failure,
    calls = []
  let player = {
    play: () => {
      calls.push('play')
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    pause: async () => {
      calls.push('pause')
      playing = false
    },
  }
  const toggle = createPlaybackToggle({
    enabled: () => enabled,
    getPlayer: () => player,
    isPlaying: () => playing,
    onError: (error) => {
      failure = error
    },
  })
  const first = toggle.toggle()
  assert.equal(await toggle.toggle(), false)
  playing = true
  finish()
  assert.equal(await first, true)
  await toggle.toggle()
  assert.deepEqual(calls, ['play', 'pause'])
  const obsolete = toggle.toggle()
  const oldFinish = finish
  toggle.reset()
  const current = toggle.toggle()
  oldFinish()
  await obsolete
  assert.equal(await toggle.toggle(), false)
  finish()
  await current
  enabled = false
  assert.equal(await toggle.toggle(), false)
  enabled = true
  player = { play: () => Promise.reject(new Error('failed')) }
  await toggle.toggle()
  assert.equal(failure.message, 'failed')
  toggle.reset()
})

const surfaceUrl = await compileComponent(
  'src/components/VideoMouseSurface.vue',
)
const Surface = (await import(surfaceUrl)).default
const tick = async () => {
  for (let i = 0; i < 6; i++) await nextTick()
}
const dispatch = (element, type, x, extra = {}) => {
  const value = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(value, {
    clientX: x,
    clientY: 100,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    ...extra,
  })
  element.dispatchEvent(value)
  return value
}
const click = (element, x) => {
  dispatch(element, 'pointerdown', x)
  dispatch(element, 'pointerup', x)
  return dispatch(element, 'click', x)
}

test('mounted surface resets press state on disabled/source/unmount, measures resize, and consumes double clicks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  installDomGlobals()
  const props = reactive({ enabled: true, sourceKey: 'first' }),
    actions = []
  const host = new FakeElement('div')
  const app = testRenderer.createApp({
    render: () =>
      h(Surface, {
        ...props,
        onSeek: (delta) => actions.push(delta),
        onToggle: () => actions.push('toggle'),
      }),
  })
  app.mount(host)
  const surface = host.querySelector('.video-mouse-surface')
  let bounds = rect
  surface.box = () => bounds
  click(surface, 200)
  click(surface, 600)
  t.mock.timers.tick(300)
  click(surface, 1000)
  assert.deepEqual(actions, [-10, 'toggle', 10])
  const dblclick = dispatch(surface, 'dblclick', 1000)
  assert.equal(dblclick.defaultPrevented, true)
  assert.equal(dblclick.cancelBubble, true)
  dispatch(surface, 'pointerdown', 200)
  props.sourceKey = 'second'
  await tick()
  dispatch(surface, 'pointerup', 200)
  dispatch(surface, 'click', 200)
  props.enabled = false
  await tick()
  click(surface, 1000)
  props.enabled = true
  await tick()
  bounds = { ...rect, width: 2000 }
  click(surface, 1000) // Now central, not right.
  t.mock.timers.tick(300)
  assert.equal(actions.at(-1), 'toggle')
  dispatch(surface, 'pointerdown', 1900)
  app.unmount()
  dispatch(surface, 'pointerup', 1900)
  dispatch(surface, 'click', 1900)
  assert.equal(actions.length, 4)
})

for (const native of [false, true])
  test(`${native ? 'native overlay' : 'HTML player'} mounts the shared surface below controls and wires mouse/keyboard to one seek controller`, async (t) => {
    installDomGlobals()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    globalThis.cancelAnimationFrame = () => {}
    const listeners = new Map()
    document.addEventListener = (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    }
    document.removeEventListener = (type, listener) =>
      listeners.get(type)?.delete(listener)
    const stub = new URL('./support/videoMousePlayerStub.js', import.meta.url)
      .href
    const replacements = {
      [native
        ? '../components/VideoMouseSurface.vue'
        : './VideoMouseSurface.vue']: surfaceUrl,
      '../player/mediaPlayerBackend.js': stub,
      '../api/mediaOverlay.js': stub,
      '../composables/useThumbnailPreview.js': stub,
    }
    for (const name of [
      'ChapterControls',
      'MediaOsd',
      'ThumbnailPreview',
      'VideoProgressRange',
    ])
      replacements[`${native ? '../components/' : './'}${name}.vue`] = stub
    const url = await compileComponent(
      native
        ? 'src/media-overlay/MediaOverlay.vue'
        : 'src/components/CustomMediaPlayer.vue',
      replacements,
    )
    // Media Chrome custom elements need a browser; the actual parent Vue wiring
    // is mounted here, with only their side-effect registration removed.
    const code = await fs.readFile(fileURLToPath(url), 'utf8')
    await fs.writeFile(
      fileURLToPath(url),
      code
        .replace(/^import 'media-chrome\/[^']+'\s*$/gm, '')
        // CSS transition hooks require a browser; retain Vue's transition
        // lifecycle while checking real parent state and event wiring here.
        .replace(
          /Transition as _Transition\b/g,
          'BaseTransition as _Transition',
        ),
    )
    const Component = (await import(url)).default
    const props = reactive({ src: '/movie.mp4', kind: 'video' })
    const fullscreen = []
    overlayActions.length = 0
    const host = new FakeElement('div')
    const app = testRenderer.createApp({
      render: () =>
        h(Component, {
          ...props,
          onFullscreen: () => fullscreen.push('fullscreen'),
        }),
    })
    app.config.warnHandler = () => {}
    app.mount(host)
    await tick()
    t.after(() => {
      app.unmount()
      t.mock.timers.reset()
    })
    const player = players.at(-1)
    const surface = host.querySelector('.video-mouse-surface')
    assert.ok(surface)
    surface.box = () => rect
    if (!native) {
      assert.equal(surface.getAttribute('slot'), 'gestures-chrome')
      assert.notEqual(surface.getAttribute('noautohide'), null)
    } else assert.equal(surface.parentNode.className, 'media-overlay-stage')
    for (let i = 0; i < 3; i++) click(surface, 1000)
    const key = {
      key: 'ArrowLeft',
      composedPath: () => [],
      preventDefault() {},
      stopPropagation() {},
    }
    for (const listener of listeners.get('keydown')) listener(key)
    await tick()
    assert.match(
      host.querySelector('.video-seek-feedback').textContent,
      /\+20 s/,
    )
    t.mock.timers.tick(180)
    await tick()
    assert.deepEqual(player.seeks, [80])
    assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
    assert.match(
      host.querySelector('.video-seek-feedback').textContent,
      /\+20 s/,
    )
    t.mock.timers.tick(1199)
    await tick()
    assert.ok(host.querySelector('.video-seek-feedback'))
    t.mock.timers.tick(1)
    await tick()
    assert.equal(host.querySelector('.video-seek-feedback'), null)
    click(surface, 600)
    t.mock.timers.tick(300)
    await tick()
    assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
    click(surface, 600)
    t.mock.timers.tick(300)
    await tick()
    assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
    click(surface, 600)
    dispatch(surface, 'pointerdown', 600)
    dispatch(surface, 'pointerup', 600)
    dispatch(surface, 'click', 600, { detail: 2 })
    dispatch(surface, 'dblclick', 600, { detail: 2 })
    t.mock.timers.tick(300)
    await tick()
    assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
    assert.deepEqual(native ? overlayActions : fullscreen, ['fullscreen'])
    // A sibling control never bubbles through the gesture surface.
    const control = host.querySelector(
      native ? '.media-overlay-control-button' : 'media-play-button',
    )
    click(control, 1000)
    await tick()
    t.mock.timers.tick(180)
    assert.deepEqual(player.seeks, [80])
    for (const status of [
      PlayerStatus.LOADING,
      PlayerStatus.ERROR,
      PlayerStatus.CLOSED,
      PlayerStatus.OPENING,
    ]) {
      player.update({ status })
      await tick()
      click(surface, 1000)
      t.mock.timers.tick(180)
    }
    assert.deepEqual(player.seeks, [80])
    player.update({ status: PlayerStatus.PAUSED })
    await tick()
    click(surface, 1000)
    if (native)
      mediaOverlay.context({
        sessionId: 'mouse-test',
        path: '/second.mp4',
        fullscreen: true,
        transitioning: true,
      })
    else props.src = '/second.mp4'
    await tick()
    t.mock.timers.tick(180)
    assert.deepEqual(player.seeks, [80])
    // Video keeps playback shortcuts regardless of how its modal was opened.
    if (native) mediaOverlay.context({ sessionId: 'mouse-test', transitioning: false })
    await tick()
    for (const quickLook of [true, false]) {
      if (native) mediaOverlay.context({ sessionId: 'mouse-test', quickLook })
      else props.quickLook = quickLook
      await tick()
      const beforeActions = overlayActions.length
      player.update({ status: PlayerStatus.PLAYING })
      await tick()
      let prevented = false, stopped = false
      const space = { key: ' ', preventDefault() { prevented = true }, stopImmediatePropagation() { stopped = true } }
      const press = (patch = {}) => {
        for (const listener of listeners.get('keydown')) listener({ ...space, ...patch })
      }
      const beforeCommands = player.commands.length
      press({ repeat: true })
      await tick()
      assert.equal(player.commands.length, beforeCommands, 'holding the opening key leaves playback unchanged')
      press()
      await tick()
      assert.equal(prevented, true)
      assert.equal(stopped, true, 'focused controls cannot also toggle playback')
      assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
      assert.equal(player.commands.length, beforeCommands + 1)
      press({ repeat: true })
      await tick()
      assert.equal(player.snapshot().status, PlayerStatus.PAUSED)
      for (const patch of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) press(patch)
      await tick()
      assert.equal(player.commands.length, beforeCommands + 1)
      press()
      await tick()
      assert.equal(player.snapshot().status, PlayerStatus.PLAYING)
      assert.equal(player.commands.length, beforeCommands + 2)
      assert.equal(overlayActions.length, beforeActions, 'Space never closes the video modal')
    }
    app.unmount()
    assert.equal(listeners.get('keydown').size, 0)
  })
