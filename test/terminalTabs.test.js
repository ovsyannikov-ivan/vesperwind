import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  closeTerminalTab,
  createTerminalTab,
} from '../src/utils/terminalTabs.js'

const read = (relativePath) =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('creates distinct local and remote terminal tab descriptors', () => {
  const first = createTerminalTab({ id: 'terminal-1', localNumber: 1 })
  const second = createTerminalTab({ id: 'terminal-2', localNumber: 2 })
  const remote = createTerminalTab({
    id: 'terminal-3',
    type: 'ssh',
    profile: { id: 'server-01', name: 'server-01', username: 'deploy', host: 'host' },
  })

  assert.deepEqual([first.id, second.id, remote.id], [
    'terminal-1',
    'terminal-2',
    'terminal-3',
  ])
  assert.deepEqual([first.title, second.title, remote.title], [
    'Local',
    'Local 2',
    'server-01',
  ])
  assert.equal(remote.connectionId, 'server-01')
})

test('switching and closing terminal tabs retains the neighboring sessions', () => {
  const tabs = [
    createTerminalTab({ id: 'terminal-1', localNumber: 1 }),
    createTerminalTab({ id: 'terminal-2', localNumber: 2 }),
    createTerminalTab({ id: 'terminal-3', localNumber: 3 }),
  ]

  assert.deepEqual(closeTerminalTab(tabs, 'terminal-2', 'terminal-2'), {
    tabs: [tabs[0], tabs[2]],
    activeId: 'terminal-3',
  })
  assert.deepEqual(closeTerminalTab(tabs, 'terminal-1', 'terminal-3'), {
    tabs: [tabs[0], tabs[1]],
    activeId: 'terminal-1',
  })
})

test('terminal dropdown and instances preserve independent lifecycle wiring', async () => {
  const [panel, editor, styles, instance, terminal, nodeBackend, rustBackend] = await Promise.all([
    read('src/components/TerminalPanel.vue'),
    read('src/components/EditorWorkspace.vue'),
    read('src/styles/main.css'),
    read('src/components/TerminalInstance.vue'),
    read('src/composables/useTerminal.js'),
    read('server/terminal.js'),
    read('src-tauri/src/terminal/mod.rs'),
  ])

  assert.match(panel, /<Teleport to="body">/u)
  assert.match(panel, /> Local Terminal<\/button>/u)
  assert.match(panel, /class="dropdown-header">REMOTE/u)
  assert.match(panel, /No saved connections/u)
  assert.match(panel, /Manage Connections…/u)
  assert.match(panel, /add\('ssh', profile\)/u)
  assert.match(panel, /:key="tab\.id"/u)
  assert.match(panel, /class="tab-close"/u)
  assert.match(panel, /class="mdi mdi-close"/u)
  assert.match(editor, /class="tab-close"/u)
  assert.match(styles, /\.tab-close:hover,[\s\S]*background: var\(--hover\)/u)
  assert.doesNotMatch(styles, /terminal-tab-close:hover/u)
  assert.match(instance, /defineExpose\(\{ restart, activate \}\)/u)
  assert.match(terminal, /terminalApi\.closeSession\(response\.sessionId\)/u)
  assert.match(terminal, /unsubscribeData\?\.\(\)/u)
  assert.match(terminal, /inputSubscription\?\.dispose\(\)/u)
  assert.match(nodeBackend, /const sessions = new Map\(\)/u)
  assert.match(nodeBackend, /const id = randomUUID\(\)/u)
  assert.match(nodeBackend, /sessions\.set\(id,/u)
  assert.match(rustBackend, /sessions: Mutex<HashMap<String, TerminalSession>>/u)
  assert.match(rustBackend, /Uuid::new_v4\(\)\.to_string\(\)/u)
})
