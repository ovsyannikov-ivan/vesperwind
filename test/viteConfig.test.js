import assert from 'node:assert/strict'
import test from 'node:test'
import config from '../vite.config.js'

test('does not watch Cargo build artifacts', () => {
  assert.ok(config.server.watch.ignored.includes('**/src-tauri/target/**'))
})
