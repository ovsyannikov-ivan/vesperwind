import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { useEditorLayout } from '../src/composables/useEditorLayout.js'
import { compiledStyles } from './support/styles.js'

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('File Manager and EditorTree use the same row height and icon contract', async () => {
  const [css, node, panel, editor] = await Promise.all([
    Promise.resolve(compiledStyles('src/styles/main.scss')), read('src/components/FileTreeNode.vue'),
    read('src/components/FilePanel.vue'), read('src/components/EditorTree.vue'),
  ])
  assert.match(css, /--file-tree-row-height: 22px/u)
  assert.match(css, /height: var\(--file-tree-row-height\)/u)
  assert.doesNotMatch(css, /\.tree-row\.is-compact\s*\{[^}]*height:/u)
  assert.match(node, /var\(--file-tree-indent\)/u)
  assert.match(node, /var\(--file-tree-row-padding\)/u)
  assert.match(panel, /<FileTree/u)
  assert.match(editor, /<FileTree/u)
})

test('editor sidebar collapse retains width in shared session state', () => {
  const { editorLayout, setTreeWidth, toggleTree } = useEditorLayout()
  const original = editorLayout.treeVisible
  setTreeWidth(310, 1000)
  toggleTree()
  assert.equal(editorLayout.treeVisible, !original)
  assert.equal(editorLayout.treeWidth, 310)
  toggleTree()
  assert.equal(editorLayout.treeVisible, original)
  assert.equal(editorLayout.treeWidth, 310)
})

const cssRule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u'))?.[1] || ''
}

test('editor tree and file panels meet at a 1px seam with a wider resize hit area', async () => {
  const [css, workspace, manager, splitter] = await Promise.all([
    Promise.resolve(compiledStyles('src/styles/main.scss')), read('src/components/EditorWorkspace.vue'),
    read('src/components/FileManager.vue'), read('src/components/Splitter.vue'),
  ])
  assert.match(workspace, /<Splitter v-if="editorLayout\.treeVisible" orientation="vertical" seam /u)
  assert.match(manager, /<Splitter\s+v-if="bothPanelsVisible"\s+orientation="vertical"\s+seam\b/u)
  assert.match(splitter, /'splitter-seam': seam/u)
  assert.match(css, /--panel-seam-width: 1px;/u)
  assert.match(cssRule(css, '.splitter-vertical.splitter-seam'), /flex: 0 0 var\(--panel-seam-width\);[^}]*background: transparent;/u)
  const hitArea = cssRule(css, '.splitter-vertical.splitter-seam::before')
  assert.match(hitArea, /right: -\d+px;/u)
  assert.match(hitArea, /left: -\d+px;/u)
  assert.match(cssRule(css, '.splitter-vertical.splitter-seam::after'), /width: var\(--panel-seam-width\);/u)
  assert.doesNotMatch(css, /\.files-container > \.splitter-vertical/u)
})

test('editor sidebar Files button matches the compact sidebar control height', async () => {
  const [css, workspace] = await Promise.all([Promise.resolve(compiledStyles('src/styles/main.scss')), read('src/components/EditorWorkspace.vue')])
  const button = workspace.match(/<button\b[^>]*title="Return to file panels"[^>]*>/u)[0]
  assert.match(button, /class="compact-button"/u)
  assert.doesNotMatch(button, /\b(btn|toolbar-button)\b/u)
  assert.match(cssRule(css, '.compact-icon-button,\n.compact-button'), /height: 24px;/u)
})
