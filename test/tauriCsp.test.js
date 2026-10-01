import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')

// Monaco token colors and view-line positions, and xterm's DOM-renderer palette,
// are runtime <style> elements and inline style attributes. Tauri adds a nonce
// to style-src for every <style> in a production HTML asset, and browsers then
// ignore 'unsafe-inline', which leaves the editor and terminal monochrome.
test('Tauri keeps inline runtime styles allowed for Monaco and xterm', async () => {
  const { app: { security } } = JSON.parse(await read('src-tauri/tauri.conf.json'))
  const styleSrc = security.csp.split(';').map((value) => value.trim().split(/\s+/))
    .find(([directive]) => directive === 'style-src')
  assert.ok(styleSrc?.includes("'unsafe-inline'"), "style-src must allow 'unsafe-inline'")
  assert.ok(!styleSrc.some((source) => /^'(nonce|sha\d+)-/u.test(source)), 'style-src must not pin nonces or hashes')

  const disabled = security.dangerousDisableAssetCspModification
  assert.ok(
    disabled === true || (Array.isArray(disabled) && disabled.includes('style-src')),
    'Tauri must not add style nonces, which would disable unsafe-inline',
  )
  assert.ok(!(Array.isArray(disabled) && disabled.includes('script-src')), 'inline script hashing stays enabled')
})
