import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  crossedPanelSwapThreshold,
  isPanelSwapHandle,
  oppositePanelSide,
  swapPanelPair,
} from '../src/utils/panelSwap.js'

const read = (relativePath) =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

const verifyProviderSwap = (leftProvider, rightProvider) => {
  const left = {
    id: 'panel-a',
    providerId: leftProvider,
    state: { path: '/left', selected: '/left/a', expanded: ['/left/folder'], scrollTop: 42 },
  }
  const right = {
    id: 'panel-b',
    providerId: rightProvider,
    state: { path: '/right', selected: '/right/b', expanded: ['/right/folder'], scrollTop: 84 },
  }
  const swapped = swapPanelPair({ left, right })

  assert.equal(swapped.left, right)
  assert.equal(swapped.right, left)
  assert.equal(swapped.left.state.scrollTop, 84)
  assert.equal(swapped.right.state.expanded[0], '/left/folder')
}

test('swaps Local/Local, Local/SFTP, and SFTP/SFTP logical panels intact', () => {
  verifyProviderSwap('local', 'local')
  verifyProviderSwap('local', 'sftp:server-01')
  verifyProviderSwap('sftp:server-01', 'sftp:server-02')
})

test('keeps the active logical panel active after moving to the opposite side', () => {
  assert.equal(oppositePanelSide('left'), 'right')
  assert.equal(oppositePanelSide('right'), 'left')
})

test('keeps file operation source and target attached to their logical panels', () => {
  const states = {
    left: { providerId: 'local', currentDirectory: '/Users/ivan', selected: '/Users/ivan/a.txt' },
    right: { providerId: 'sftp:server-01', currentDirectory: '/var/www', selected: '/var/www/b.txt' },
  }
  const swapped = swapPanelPair(states)
  const activeSide = oppositePanelSide('left')
  const targetSide = oppositePanelSide(activeSide)

  assert.equal(swapped[activeSide], states.left)
  assert.equal(swapped[targetSide], states.right)
  assert.equal(swapped[activeSide].selected, '/Users/ivan/a.txt')
  assert.equal(swapped[targetSide].currentDirectory, '/var/www')
})

test('starts panel swap only beyond the movement threshold and outside controls', () => {
  assert.equal(crossedPanelSwapThreshold(10, 10, 14, 13), false)
  assert.equal(crossedPanelSwapThreshold(10, 10, 16, 10), true)
  assert.equal(isPanelSwapHandle({ closest: () => null }), true)
  assert.equal(isPanelSwapHandle({ closest: () => ({ tagName: 'BUTTON' }) }), false)
})

test('panel swap uses pointer gestures without replacing file drag payloads', async () => {
  const [manager, panel, node] = await Promise.all([
    read('src/components/FileManager.vue'),
    read('src/components/FilePanel.vue'),
    read('src/components/FileTreeNode.vue'),
  ])

  assert.match(manager, /panelSlots\.left = nextSlots\.left/u)
  assert.match(manager, /activePanel\.value = oppositePanelSide\(activePanel\.value\)/u)
  assert.match(manager, /:key="`\$\{panelSlots\.left\.id\}:\$\{panelSlots\.left\.providerId\}`"/u)
  assert.match(panel, /@pointerdown="handleHeaderPointerDown"/u)
  assert.match(panel, /isPanelSwapHandle\(event\.target\)/u)
  assert.match(node, /FILE_ENTRY_MIME/u)
  assert.match(node, /@dragstart="handleDragStart"/u)
  assert.doesNotMatch(panel, /draggable="true"/u)
})
