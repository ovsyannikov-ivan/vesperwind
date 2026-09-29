import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { useEditorLayout } from '../src/composables/useEditorLayout.js'

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('File Manager and EditorTree use the same row height and icon contract', async () => {
  const [css, node, panel, editor] = await Promise.all([
    read('src/styles/main.css'), read('src/components/FileTreeNode.vue'),
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
