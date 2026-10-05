import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { useMediaViewer } from '../src/composables/useMediaViewer.js'
import { effectScope, ref, watch, nextTick } from 'vue'

const node = (name) => ({
  name,
  path: `/gallery/${name}`,
  isDirectory: false,
})

test('URL video preparation updates reactive viewer state and both provider/URL presentation use preparedSource', async () => {
  const scope = effectScope()
  let finish, presented = ''
  const viewer = scope.run(() => useMediaViewer({ audio: { current: ref(null) },
    prepareMedia: () => new Promise((resolve) => { finish = resolve }) }))
  scope.run(() => watch(() => viewer.currentViewerMedia.value?.preparedSource, (source) => { presented = source }))
  viewer.openSource({ sourceType: 'url', url: 'https://example.com/video' }, { kind: 'video' })
  await nextTick()
  finish({ ok: true, source: 'https://example.com/video' })
  await nextTick(); await nextTick()
  assert.equal(presented, 'https://example.com/video')
  assert.equal(viewer.currentViewerMedia.value.loading, false)
  assert.equal(viewer.currentViewerMedia.value.historyEnabled, false)
  const markup = fs.readFileSync(new URL('../src/components/MediaViewerModal.vue', import.meta.url), 'utf8')
  for (const kind of ['image', 'video']) assert.ok(markup.includes(`displayedMedia?.preparedSource && displayedKind === '${kind}'`))
  scope.stop()
})

test('builds an image carousel from sibling files and wraps navigation', () => {
  const first = node('first.jpg')
  const second = node('second.png')
  const video = node('clip.mp4')
  const viewer = useMediaViewer()

  assert.equal(
    viewer.openMedia({ node: first, siblings: [first, second, video] }),
    true,
  )
  assert.equal(viewer.viewer.value.kind, 'image')
  assert.equal(viewer.viewerCount.value, 2)
  assert.equal(viewer.currentViewerMedia.value.path, first.path)

  viewer.showNext()
  assert.equal(viewer.currentViewerMedia.value.path, second.path)
  viewer.showNext()
  assert.equal(viewer.currentViewerMedia.value.path, first.path)
  viewer.showPrevious()
  assert.equal(viewer.currentViewerMedia.value.path, second.path)
})

test('builds a video carousel with the MKV web fallback source', () => {
  const first = node('first.mp4')
  const second = node('second.mov')
  const matroska = node('archive.mkv')
  const viewer = useMediaViewer()

  viewer.openMedia({
    node: second,
    siblings: [first, matroska, second],
  })

  assert.equal(viewer.viewer.value.kind, 'video')
  assert.deepEqual(
    viewer.viewer.value.items.map((item) => item.name),
    ['first.mp4', 'archive.mkv', 'second.mov'],
  )
  assert.equal(viewer.currentViewerMedia.value.path, second.path)
})

test('native audio and subtitle selectors use vertical Bootstrap dropdown menus', () => {
  const component = fs.readFileSync(
    fileURLToPath(new URL('../src/media-overlay/MediaOverlay.vue', import.meta.url)),
    'utf8',
  )

  assert.match(component, /media-overlay-dropdown/)
  assert.match(component, /class="dropdown-menu show"/)
  assert.doesNotMatch(component, /dropdown-menu-dark/)
  assert.match(component, /class="dropdown-item"/)
  assert.match(component, /handlePointerDown/)

  const styles = fs.readFileSync(
    fileURLToPath(new URL('../src/media-overlay/media-overlay.css', import.meta.url)),
    'utf8',
  )
  assert.match(styles, /\.media-overlay-dropdown \.dropdown-menu\s*\{[^}]*max-height:/s)
  assert.match(styles, /--bs-dropdown-font-size:\s*0\.875rem/)
})

test('native video chrome lives in a transparent child WebView with stable geometry', () => {
  const projectFile = (path) => fs.readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    'utf8',
  )
  const tauri = projectFile('src-tauri/src/lib.rs')
  const commands = projectFile('src-tauri/src/commands/player.rs')
  const surfaces = ['surface_opengl_macos.rs', 'surface_metal_macos.rs'].map((file) => projectFile(`src-tauri/src/mpv/${file}`))
  const player = projectFile('src/components/CustomMediaPlayer.vue')
  const modal = projectFile('src/components/MediaViewerModal.vue')

  assert.match(tauri, /WebviewBuilder::new\([\s\S]*"media-overlay"/)
  assert.match(tauri, /add_child\(\s*overlay_builder/)
  assert.match(tauri, /\.transparent\(true\)/)
  assert.doesNotMatch(tauri, /overlay\.hide\(\)/)
  assert.doesNotMatch(commands, /overlay\.(?:hide|show)\(\)/)
  assert.match(commands, /contentLayoutRect\(\)/)
  assert.match(commands, /geometry\.height \* geometry\.scale_factor/)
  assert.match(commands, /geometry\.y\.max\(0\.0\)/)
  assert.match(player, /class="native-mpv-surface"/)
  assert.match(player, /borderRadius:\s*modalBorderRadius\(\)/)
  assert.match(player, /subtitlePosition:\s*subtitlePosition\(rect\.height\)/)
  assert.match(player, /if \(props\.fullscreen\) return 100/)
  for (const surface of surfaces) {
    assert.match(surface, /setCornerRadius\(geometry\.border_radius/)
    assert.match(surface, /setMasksToBounds\(geometry\.border_radius\s*>\s*0\.0\)/)
    assert.match(surface, /CACornerMask::LayerMinXMinYCorner/)
  }
  assert.doesNotMatch(player, /native-mpv-controls/)
  assert.match(modal, /isNativeVideo/)
  assert.match(modal, /@backend="playerBackend = \$event"/)
})

test('native overlay hides and restores the cursor with playback controls', () => {
  const component = fs.readFileSync(
    fileURLToPath(new URL('../src/media-overlay/MediaOverlay.vue', import.meta.url)),
    'utf8',
  )
  const styles = fs.readFileSync(
    fileURLToPath(new URL('../src/media-overlay/media-overlay.css', import.meta.url)),
    'utf8',
  )

  assert.match(component, /is-cursor-hidden/)
  assert.match(component, /@pointerleave="restoreControls"/)
  assert.match(component, /document\.addEventListener\('wheel', showControls/)
  assert.match(styles, /\.media-overlay\.is-cursor-hidden[\s\S]*cursor:\s*none/)
  assert.match(styles, /\.media-overlay-controls\s*\{[^}]*inset:\s*auto 1px 0/s)
})

test('native Info button remains inside the popup boundary so repeated clicks toggle it closed', () => {
  const component = fs.readFileSync(
    fileURLToPath(new URL('../src/media-overlay/MediaOverlay.vue', import.meta.url)),
    'utf8',
  )

  assert.match(component, /activeMenu\.value === menu \? '' : menu/)
  assert.match(component, /closest\?\.\('\.media-overlay-dropdown, \.media-overlay-info, \.media-overlay-info-toggle'\)/)
  assert.match(component, /class="btn btn-sm btn-dark media-overlay-info-toggle"/)
})

test('Enter opens focused files while retaining directory toggle behavior', () => {
  const component = fs.readFileSync(
    fileURLToPath(new URL('../src/components/FileTreeNode.vue', import.meta.url)),
    'utf8',
  )

  assert.match(component, /if \(props\.node\.isDirectory\) toggle\(\)/)
  assert.match(component, /else emit\('open', props\.node\)/)
})

test('native mpv styles only cover classes the player markup still uses', () => {
  const read = (path) => fs.readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
  const styles = read('src/styles/main.css')
  const markup = ['src/components/CustomMediaPlayer.vue', 'src/components/MediaViewerModal.vue']
    .map(read).join('\n')
  const classes = new Set(styles.match(/\.native-mpv-[\w-]+/gu)?.map((name) => name.slice(1)))
  assert.ok(classes.size > 0)
  for (const name of classes) assert.match(markup, new RegExp(`\\b${name}\\b`, 'u'), `${name} is unused`)
})
