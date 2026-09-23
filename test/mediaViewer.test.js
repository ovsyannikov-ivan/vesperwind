import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { useMediaViewer } from '../src/composables/useMediaViewer.js'

const node = (name) => ({
  name,
  path: `/gallery/${name}`,
  isDirectory: false,
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
  assert.match(component, /dropdown-menu dropdown-menu-dark show/)
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
  const surface = projectFile('src-tauri/src/mpv/surface_macos.rs')
  const player = projectFile('src/components/CustomMediaPlayer.vue')
  const modal = projectFile('src/components/MediaViewerModal.vue')

  assert.match(tauri, /add_child\([\s\S]*"media-overlay"/)
  assert.match(tauri, /\.transparent\(true\)/)
  assert.doesNotMatch(tauri, /overlay\.hide\(\)/)
  assert.doesNotMatch(commands, /overlay\.(?:hide|show)\(\)/)
  assert.match(commands, /contentLayoutRect\(\)/)
  assert.match(commands, /geometry\.height \+ titlebar_offset - border_inset/)
  assert.match(commands, /geometry\.y\.max\(0\.0\)/)
  assert.match(player, /class="native-mpv-surface"/)
  assert.match(player, /borderRadius:\s*modalBorderRadius\(\)/)
  assert.match(player, /subtitlePosition:\s*subtitlePosition\(rect\.height\)/)
  assert.match(player, /if \(props\.fullscreen\) return 100/)
  assert.match(surface, /setCornerRadius\(geometry\.border_radius/)
  assert.match(surface, /setMasksToBounds\(geometry\.border_radius\s*>\s*0\.0\)/)
  assert.match(surface, /CACornerMask::LayerMinXMinYCorner/)
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
