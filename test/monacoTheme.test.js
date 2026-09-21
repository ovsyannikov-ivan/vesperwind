import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  dark2026Theme,
  VESPERWIND_DARK_2026_THEME_ID,
} from '../src/editor/themes/dark2026.js'

const rulesFor = (token) =>
  dark2026Theme.rules.filter((rule) => rule.token === token)

test('registers the resolved official VS Code Dark 2026 Monaco theme', async () => {
  assert.equal(VESPERWIND_DARK_2026_THEME_ID, 'vesperwind-dark-2026')
  assert.equal(dark2026Theme.base, 'vs-dark')
  assert.equal(dark2026Theme.inherit, false)
  assert.equal(dark2026Theme.colors['editor.background'], '#121314')
  assert.equal(dark2026Theme.colors['editor.foreground'], '#BBBEBF')
  assert.ok(dark2026Theme.rules.length >= 250)

  const generated = await fs.readFile(
    new URL('../src/editor/themes/dark2026.js', import.meta.url),
    'utf8',
  )
  assert.match(
    generated,
    /dark_vs\.json -> dark_plus\.json -> dark_modern\.json -> 2026-dark\.json/,
  )
})

test('keeps representative syntax rules used by supported editor languages', () => {
  // JavaScript, TypeScript, Vue and Shell use the generic keyword/string rules;
  // Vue/HTML use tag scopes; JSON/CSS have property/tag scopes; Markdown uses
  // markup scopes. SQL tokenizers also fall back to the generic keyword rule.
  for (const token of [
    'keyword',
    'string',
    'comment',
    'variable',
    'entity.name.function',
    'entity.name.tag',
    'entity.name.tag.css',
    'support.type.property-name.json',
    'markup.heading',
  ]) {
    assert.ok(rulesFor(token).length > 0, `missing Dark 2026 rule for ${token}`)
  }
})
