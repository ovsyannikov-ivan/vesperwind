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
    for (const button of footer.matchAll(/<button\b[^>]*\bclass="([^"]*)"[^>]*>/g)) {
      const tokens = button[1].split(/\s+/)
      assert.ok(tokens.includes('btn-sm'), `${name}: footer buttons must use btn-sm`)
      assert.ok(!tokens.includes('btn-outline-danger'), `${name}: destructive buttons must be solid`)
      assert.ok(!tokens.includes('btn-secondary'), `${name}: neutral footer buttons use btn-neutral`)
      // Primary/destructive variants may come from :class; Settings reset is
      // the explicit outline exception in AGENTS.md.
      const isPrimaryOrDestructive = /\bbtn-(?:primary|danger)\b/u.test(button[0])
      const isSettingsReset = name === 'SettingsModal.vue' && /@click="reset"/u.test(button[0]) && tokens.includes('btn-outline-secondary')
      if (!isPrimaryOrDestructive && !isSettingsReset) {
        assert.ok(tokens.includes('btn-neutral'), `${name}: neutral footer buttons need btn-neutral`)
      }
    }
  }
})

const sourceFiles = async (directory) => {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && /\.(vue|js)$/u.test(entry.name))
    .map((entry) => new URL(`${entry.parentPath.slice(directory.pathname.length)}/${entry.name}`.replace(/^\//u, ''), directory))
}

test('targeted neutral actions share one compact btn-neutral style', async () => {
  const css = await fs.readFile(new URL('../src/styles/main.css', import.meta.url), 'utf8')
  assert.equal(css.match(/^\.btn-neutral\s*\{/gmu)?.length, 1, 'define btn-neutral once in main.css')
  const rule = css.match(/^\.btn-neutral\s*\{([^}]*)\}/mu)[1]
  assert.match(rule, /--bs-btn-bg: var\(--toolbar-control-active-bg\)/u)
  assert.match(rule, /--bs-btn-border-color: var\(--toolbar-control-border\)/u)

  for (const file of await sourceFiles(new URL('../src/', import.meta.url))) {
    const source = await fs.readFile(file, 'utf8')
    const name = file.pathname.split('/src/')[1]
    if (name.endsWith('.vue')) assert.doesNotMatch(source, /\.btn-neutral\b[^{]*\{/u, `${name}: do not restyle btn-neutral locally`)
  }

  // Guard the migrated controls, not every occurrence of btn-secondary:
  // AGENTS.md permits deliberate, documented exceptions elsewhere.
  const neutralControls = [
    ['SettingsModal.vue', /<button\b[^>]*@click="close"[^>]*>\s*Cancel\s*<\/button>/u],
    ['FilePanel.vue', /<button\b[^>]*@click="closeSearch"[^>]*>/u],
    ['RemoteConnectionsModal.vue', /<button\b[^>]*@click="newProfile"[^>]*>/u],
  ]
  for (const [name, pattern] of neutralControls) {
    const source = await fs.readFile(new URL(name, components), 'utf8')
    const button = source.match(pattern)?.[0]
    assert.ok(button, `${name}: targeted neutral control must exist`)
    const tokens = button.match(/\bclass="([^"]*)"/u)?.[1].split(/\s+/u) || []
    for (const token of ['btn', 'btn-sm', 'btn-neutral']) {
      assert.ok(tokens.includes(token), `${name}: targeted neutral control needs ${token}`)
    }
    assert.ok(!tokens.includes('btn-secondary'), `${name}: targeted neutral control must not use btn-secondary`)
  }

  const panel = await fs.readFile(new URL('FilePanel.vue', components), 'utf8')
  const actions = panel.match(/<div class="tree-filter-actions">([\s\S]*?)<\/div>/u)[1]
  const classes = [...actions.matchAll(/<button\b[^>]*\bclass="([^"]*)"/gu)].map((match) => match[1].split(/\s+/u))
  assert.equal(classes.length, 2)
  for (const tokens of classes) assert.deepEqual(tokens, ['btn', 'btn-sm', 'btn-neutral'])
  // Filter actions split the menu width evenly instead of wrapping.
  const compactCss = css.replace(/\s+/gu, ' ')
  assert.match(compactCss, /\.tree-filter-actions \{ display: flex; gap: [^;]+; margin-top: [^;]+; \}/u)
  assert.match(compactCss, /\.tree-filter-actions > \.btn \{ flex: 1 1 0; min-width: 0;[^}]*white-space: nowrap; \}/u)
})
