import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const read = (relativePath) => fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('terminal workspace keeps one xterm component and backend session per tab', async () => {
  const [panel, instance, terminal] = await Promise.all([
    read('src/components/TerminalPanel.vue'),
    read('src/components/TerminalInstance.vue'),
    read('src/composables/useTerminal.js'),
  ])

  assert.match(panel, /<TerminalInstance\s+v-for="tab in tabs"\s+:key="tab\.id"/)
  assert.match(panel, /add\('local'\)/)
  assert.match(panel, /add\('ssh', profile\)/)
  assert.match(panel, /@click="manageConnections"/)
  assert.match(instance, /useTerminal\(container, visible/)
  assert.match(terminal, /payload\.sessionId === sessionId\.value/)
  assert.match(terminal, /disposed \|\| generation !== createGeneration/)
  assert.match(panel, /Disconnected/)
  assert.match(panel, /@click\.stop="restart"/)
})

test('fullscreen handling stays centralized and exposes an image exit control', async () => {
  const [controller, viewer] = await Promise.all([
    read('src/api/fullscreen.js'),
    read('src/components/MediaViewerModal.vue'),
  ])

  assert.match(controller, /backendRuntimeMode === 'tauri'/)
  assert.match(controller, /getCurrentWindow\(\)\.setFullscreen\(true\)/)
  assert.match(controller, /element\.requestFullscreen/)
  assert.match(viewer, /from '\.\.\/api\/fullscreen\.js'/)
  assert.match(viewer, /class="btn media-viewer-fullscreen-exit"/)
  assert.match(viewer, /aria-label="Exit fullscreen"/)
})

test('changed SSH host keys are blocked instead of offering one-click trust', async () => {
  const modal = await read('src/components/RemoteConnectionsModal.vue')
  assert.match(modal, /EHOSTKEY_CHANGED/)
  assert.match(modal, /SSH host key changed — connection blocked/)
  assert.match(modal, /<button v-else[^>]*>Trust and connect<\/button>/)
})

test('editor tree keeps the remote provider when it lists and mutates files', async () => {
  const tree = await read('src/components/EditorTree.vue')
  assert.match(tree, /useFilesystem\(props\.context\.filesystemId\)/)
  assert.match(tree, /:provider-id="context\.filesystemId"/)
})
