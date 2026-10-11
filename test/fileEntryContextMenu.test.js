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

  assert.match(menu, /defineEmits\(\[[^\]]*'rename'[^\]]*'delete'[^\]]*'cancel'/u)
  assert.match(menu, /v-if="nativeActions"[\s\S]*?@click="\$emit\('system-open'\)"/u)
  assert.match(menu, /v-if="nativeActions && openWithAvailable && !request\.node\.isDirectory"/u)
  assert.match(menu, /nativeActions && request\.node\.isDirectory \? 'Open in Panel' : actionLabel/u)
  assert.match(menu, /@click="\$emit\('reveal'\)"/u)
  assert.match(manager, /:native-actions="desktop\.available && entryContextRequest\.node\.providerId === 'local'"/u)
  assert.match(menu, /@click="\$emit\('rename'\)"[\s\S]*?Rename/u)
  assert.match(
    manager,
    /const executeEntryContextRename = \(\) => \{[\s\S]*?entryContextRequest\.value = null[\s\S]*?panel\?\.requestRename\(requestDetails\.node\)[\s\S]*?\n\}/u,
  )
  assert.match(manager, /@rename="executeEntryContextRename"/u)
  assert.match(panel, /selectNode\(node\)[\s\S]*?renameRequest\.value = \{[\s\S]*?path: node\.path/u)
  assert.match(panel, /defineExpose\(\{ openNode, requestRename, removeSelectedPaths, editAddress, quickLookContext,/u)
  assert.match(panel, /:rename-request="renameRequest"/u)
  // The tree finds the requested row logically (it may not be mounted),
  // selects it, scrolls it into view and starts the rename there.
  assert.match(tree, /watch\(\(\) => props\.renameRequest, async \(request\) => \{[\s\S]*?tree\.indexOf\(request\.path\)[\s\S]*?emit\('select', \{ node: row\.entry \}\)[\s\S]*?await nextTick\(\)[\s\S]*?await startRename\(row\.entry\)/u)
  assert.match(tree, /tree\.beginRename\(entry\)\n  await revealPath\(entry\.path\)/u)
  assert.match(node, /renaming = computed\(\(\) => props\.depth > 0 && rename\.path === props\.node\.path\)/u)
})
