import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { resolveTauriCli } from '../scripts/tauri-cli.js'

test('resolves the installed Tauri CLI to a native absolute path', () => {
  const entry = resolveTauriCli()

  assert.equal(path.isAbsolute(entry), true)
  assert.equal(path.basename(entry), 'tauri.js')
  assert.equal(entry.includes(`${path.sep}@tauri-apps${path.sep}cli${path.sep}`), true)
})
