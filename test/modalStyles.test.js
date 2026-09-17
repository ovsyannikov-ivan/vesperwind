import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const components = new URL('../src/components/', import.meta.url)

test('all modal headings and footer buttons keep the shared compact style', async () => {
  const files = (await fs.readdir(components)).filter((name) => name.endsWith('Modal.vue'))
  assert.ok(files.length > 0)

  for (const name of files) {
    const source = await fs.readFile(new URL(name, components), 'utf8')
    const heading = source.match(/<h1\b[^>]*class="([^"]*\bmodal-title\b[^"]*)"[^>]*>([\s\S]*?)<\/h1>/)
    assert.ok(heading, `${name}: use the shared modal heading`)
    for (const token of ['fs-6', 'd-flex', 'align-items-center', 'gap-2']) {
      assert.ok(heading[1].split(/\s+/).includes(token), `${name}: heading needs ${token}`)
    }
    assert.match(heading[2], /<i\b[^>]*class="mdi\b[^>]*aria-hidden="true"/, `${name}: heading needs a decorative icon`)

    const footer = source.split(/class="modal-footer\b[^\"]*"/)[1]
    if (!footer) continue // Media viewers use their own playback controls.
    for (const button of footer.matchAll(/<button\b[^>]*\bclass="([^"]*)"/g)) {
      assert.ok(button[1].split(/\s+/).includes('btn-sm'), `${name}: footer buttons must use btn-sm`)
      assert.ok(!button[1].split(/\s+/).includes('btn-outline-danger'), `${name}: destructive buttons must be solid`)
    }
  }
})
