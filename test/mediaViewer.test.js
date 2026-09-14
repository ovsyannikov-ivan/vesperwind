import assert from 'node:assert/strict'
import test from 'node:test'
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

test('builds a video carousel without browser-incompatible MKV files', () => {
  const first = node('first.mp4')
  const second = node('second.mov')
  const unsupported = node('archive.mkv')
  const viewer = useMediaViewer()

  viewer.openMedia({
    node: second,
    siblings: [first, unsupported, second],
  })

  assert.equal(viewer.viewer.value.kind, 'video')
  assert.deepEqual(
    viewer.viewer.value.items.map((item) => item.name),
    ['first.mp4', 'second.mov'],
  )
  assert.equal(viewer.currentViewerMedia.value.path, second.path)
})
