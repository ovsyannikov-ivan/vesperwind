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
      assert.ok(!button[1].split(/\s+/).includes('btn-secondary'), `${name}: neutral footer buttons use btn-neutral`)
    }
  }
})

const sourceFiles = async (directory) => {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && /\.(vue|js)$/u.test(entry.name))
    .map((entry) => new URL(`${entry.parentPath.slice(directory.pathname.length)}/${entry.name}`.replace(/^\//u, ''), directory))
}

test('neutral actions share one compact btn-neutral style instead of btn-secondary', async () => {
  const css = await fs.readFile(new URL('../src/styles/main.css', import.meta.url), 'utf8')
  assert.equal(css.match(/^\.btn-neutral\s*\{/gmu)?.length, 1, 'define btn-neutral once in main.css')
  const rule = css.match(/^\.btn-neutral\s*\{([^}]*)\}/mu)[1]
  assert.match(rule, /--bs-btn-bg: var\(--toolbar-control-active-bg\)/u)
  assert.match(rule, /--bs-btn-border-color: var\(--toolbar-control-border\)/u)

  for (const file of await sourceFiles(new URL('../src/', import.meta.url))) {
    const source = await fs.readFile(file, 'utf8')
    const name = file.pathname.split('/src/')[1]
    assert.doesNotMatch(source, /\bbtn-secondary\b/u, `${name}: use btn-neutral for neutral actions (see AGENTS.md)`)
    if (name.endsWith('.vue')) assert.doesNotMatch(source, /\.btn-neutral\b[^{]*\{/u, `${name}: do not restyle btn-neutral locally`)
  }

  const panel = await fs.readFile(new URL('FilePanel.vue', components), 'utf8')
  const actions = panel.match(/<div class="tree-filter-actions">([\s\S]*?)<\/div>/u)[1]
  const classes = [...actions.matchAll(/<button\b[^>]*\bclass="([^"]*)"/gu)].map((match) => match[1].split(/\s+/u))
  assert.equal(classes.length, 2)
  for (const tokens of classes) assert.deepEqual(tokens, ['btn', 'btn-sm', 'btn-neutral'])
  // Filter actions split the menu width evenly instead of wrapping.
  assert.match(css, /\.tree-filter-actions \{ display: flex; gap: [^;]+; margin-top: [^;]+; \}/u)
  assert.match(css, /\.tree-filter-actions > \.btn \{ flex: 1 1 0; min-width: 0;[^}]*white-space: nowrap; \}/u)
})
