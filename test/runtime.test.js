import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createRuntimeInfo,
  registerRuntimeHandlers,
} from '../server/runtime.js'
import {
  normalizeRuntimeMode,
  runtime,
} from '../src/api/runtime.js'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

test('reports browser and SEA modes from the Node backend', () => {
  assert.deepEqual(
    {
      mode: createRuntimeInfo({ sea: false }).mode,
      isStandalone: createRuntimeInfo({ sea: false }).isStandalone,
    },
    { mode: 'browser', isStandalone: false },
  )
  assert.deepEqual(
    {
      mode: createRuntimeInfo({ sea: true }).mode,
      isStandalone: createRuntimeInfo({ sea: true }).isStandalone,
    },
    { mode: 'sea', isStandalone: true },
  )
})

test('exposes runtime information through the Socket backend API', () => {
  let runtimeHandler
  registerRuntimeHandlers({
    on(eventName, handler) {
      if (eventName === 'runtime:info') {
        runtimeHandler = handler
      }
    },
  })

  assert.equal(typeof runtimeHandler, 'function')
  let response
  runtimeHandler({}, (value) => {
    response = value
  })
  assert.equal(response.mode, 'browser')
  assert.equal(response.isStandalone, false)
})

test('exposes a transport-neutral runtime API with legacy normalization', () => {
  assert.equal(runtime.mode, 'browser')
  assert.equal(runtime.isStandalone, false)
  assert.equal(normalizeRuntimeMode({ mode: 'sea' }), 'sea')
  assert.equal(normalizeRuntimeMode({ runtime: 'tauri' }), 'tauri')
  assert.equal(normalizeRuntimeMode({ mode: 'unknown' }), 'browser')
})

test('renders branding only from the centralized browser runtime mode', async () => {
  const toolbar = await fs.readFile(
    path.join(projectRoot, 'src', 'components', 'Toolbar.vue'),
    'utf8',
  )

  assert.match(toolbar, /v-if="runtime\.mode === 'browser'"/)
  assert.doesNotMatch(toolbar, /runtime\.getInfo/)
  assert.doesNotMatch(toolbar, /__TAURI|isSea\s*\(|process\.env/)
})
