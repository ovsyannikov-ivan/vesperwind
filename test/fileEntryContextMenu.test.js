import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const readComponent = (name) =>
  fs.readFile(new URL(`../src/components/${name}`, import.meta.url), 'utf8')

test('context-menu Rename starts the selected tree node inline editor', async () => {
  const [menu, manager, panel, tree, node] = await Promise.all([
    readComponent('FileEntryContextMenu.vue'),
    readComponent('FileManager.vue'),
    readComponent('FilePanel.vue'),
    readComponent('FileTree.vue'),
    readComponent('FileTreeNode.vue'),
  ])

  assert.match(menu, /defineEmits\(\['open', 'rename', 'delete', 'cancel'\]\)/u)
  assert.match(menu, /@click="\$emit\('rename'\)"[\s\S]*?Rename/u)
  assert.match(
    manager,
    /const executeEntryContextRename = \(\) => \{[\s\S]*?entryContextRequest\.value = null[\s\S]*?panel\?\.requestRename\(requestDetails\.node\)[\s\S]*?\n\}/u,
  )
  assert.match(manager, /@rename="executeEntryContextRename"/u)
  assert.match(panel, /selectNode\(node\)[\s\S]*?renameRequest\.value = \{[\s\S]*?path: node\.path/u)
  assert.match(panel, /defineExpose\(\{ openNode, requestRename \}\)/u)
  assert.match(panel, /:rename-request="renameRequest"/u)
  assert.match(tree, /:rename-request="renameRequest"/u)
  assert.match(node, /request\.path !== props\.node\.path/u)
  assert.match(node, /selectNode\(\)[\s\S]*?await nextTick\(\)[\s\S]*?await beginRename\(\)/u)
})
