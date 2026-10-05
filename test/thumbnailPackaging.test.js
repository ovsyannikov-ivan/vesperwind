import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
test('common native resources exist in a clean checkout, independently of platform sidecar builds', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
  const resources = config.bundle.resources.filter(path => !path.includes('*')).map(path => `src-tauri/${path}`)
  const tracked = new Set(execFileSync('git', ['ls-files', '--', ...resources], { cwd: repo, encoding: 'utf8' }).trim().split('\n'))
  for (const resource of resources) {
    assert.ok(tracked.has(resource), `${resource} must be available before generated platform binaries are built`)
    assert.ok((await fs.stat(new URL(`../${resource}`, import.meta.url))).size > 0)
  }
  const mac = JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.macos.conf.json', import.meta.url)))
  assert.ok(mac.bundle.externalBin.includes('binaries/ffmpeg'))
  assert.equal(mac.bundle.resources, undefined, 'platform sidecars must preserve common LOWA/libmpv resources')
})
