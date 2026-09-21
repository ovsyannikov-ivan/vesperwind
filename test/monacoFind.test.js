import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Monaco find/replace stays on the native editor contribution', async () => {
  const source = await readFile(
    new URL('../src/components/MonacoEditor.vue', import.meta.url),
    'utf8',
  )

  assert.match(source, /editor\/contrib\/find\/browser\/findController/u)
  assert.match(source, /'actions\.find'/u)
  assert.match(source, /'editor\.action\.startFindReplaceAction'/u)
  assert.match(source, /'editor\.action\.nextMatchFindAction'/u)
  assert.match(source, /'editor\.action\.previousMatchFindAction'/u)
  assert.doesNotMatch(source, /class="(?:monaco-)?find-widget"/u)
})
