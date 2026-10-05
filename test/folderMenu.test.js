import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { buildPathBreadcrumbs } from '../src/utils/pathBreadcrumbs.js'
import { currentChildPath, findTypeaheadIndex, listSubfolders } from '../src/utils/folderMenu.js'

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8')
const folder = (name, extra = {}) => ({ name, path: `/Volumes/WD/${name}`, isDirectory: true, ...extra })

test('breadcrumb folder menu lists only subfolders in natural name order', () => {
  const entries = [
    folder('Video'),
    { name: 'notes.txt', path: '/Volumes/WD/notes.txt', isDirectory: false },
    folder('apps'),
    folder('Season 10'),
    folder('Season 2'),
    folder('Linked', { isSymbolicLink: true }),
  ]

  assert.deepEqual(listSubfolders(entries).map((entry) => entry.name), ['apps', 'Linked', 'Season 2', 'Season 10', 'Video'])
  assert.deepEqual(listSubfolders(), [])
})

test('the folder after the clicked crumb is marked as the current location', () => {
  const breadcrumbs = buildPathBreadcrumbs({ name: '/', path: '/' }, '/Volumes/WD/Video')
  const index = breadcrumbs.findIndex((crumb) => crumb.name === 'WD')

  assert.equal(currentChildPath(breadcrumbs, index), '/Volumes/WD/Video')
  assert.equal(currentChildPath(breadcrumbs, breadcrumbs.length - 1), '')

  const windows = buildPathBreadcrumbs({ name: 'C:\\', path: 'C:\\' }, 'C:\\Users\\ivan')
  assert.equal(currentChildPath(windows, 0), 'C:\\Users')
})

test('type-to-select finds prefixes, cycles repeated letters, and ignores case', () => {
  const labels = ['Apps', 'Archive', 'backup', 'Video']

  assert.equal(findTypeaheadIndex(labels, 'a'), 0)
  assert.equal(findTypeaheadIndex(labels, 'a', 0), 1)
  assert.equal(findTypeaheadIndex(labels, 'a', 1), 0)
  assert.equal(findTypeaheadIndex(labels, 'ar', -1), 1)
  assert.equal(findTypeaheadIndex(labels, 'B'), 2)
  assert.equal(findTypeaheadIndex(labels, 'z'), -1)
  assert.equal(findTypeaheadIndex([], 'a'), -1)
})

test('file panels and the editor tree open the folder menu from breadcrumbs through their provider', async () => {
  const [menu, panel, editor] = await Promise.all([
    read('src/components/FolderPathMenu.vue'),
    read('src/components/FilePanel.vue'),
    read('src/components/EditorTree.vue'),
  ])

  // The menu reads folders only through the listDirectory function of the panel's provider.
  assert.match(menu, /props\.listDirectory\(props\.request\.path\)/u)
  assert.doesNotMatch(menu, /from '\.\.\/api\//u)
  assert.match(menu, /class="dropdown-menu show folder-path-menu shadow"/u)
  assert.match(menu, /navigateDropdown\(event, menuRef\.value\)/u)
  assert.match(menu, /menuRef\.value\?\.focus\(\{ preventScroll: true \}\)/u)
  assert.match(menu, /:aria-current="folder\.path === request\.currentPath \? 'location' : undefined"/u)
  assert.doesNotMatch(menu, /'active': folder/u)
  // Folder icons match the file tree, including its color and Windows drive icons.
  assert.match(menu, /getFileIcon\(folder, folder\.path === props\.request\.currentPath\)/u)
  assert.match(menu, /:class="folderIcon\(folder\)"/u)
  // Rows match the file tree (font, row height, icon size), not the context menu.
  const styles = await read('src/styles/main.css')
  assert.match(styles, /\.file-tree,\s*\.tree-children \{[^}]*font-size: 0\.75rem;/u)
  assert.match(styles, /\.dropdown-menu\.folder-path-menu \{[^}]*--bs-dropdown-font-size: 0\.75rem;/u)
  assert.match(styles, /\.dropdown-menu\.folder-path-menu \.dropdown-item:has\(> \.mdi\) \{[^}]*height: var\(--file-tree-row-height\);/u)
  assert.match(styles, /\.dropdown-menu\.folder-path-menu \.dropdown-item > \.mdi \{[^}]*font-size: var\(--file-tree-icon-size\);/u)
  const dropdown = await read('src/styles/dropdown.css')
  assert.match(dropdown, /\.dropdown-item:not\(:disabled\):is\(:hover, :active\) > \.mdi,[\s\S]*?\{\s*color: inherit;/u)

  for (const [name, source] of [['FilePanel', panel], ['EditorTree', editor]]) {
    assert.match(source, /useFilesystem\((?:\(\) => )?(props\.providerId|props\.context\.filesystemId)\)/u, `${name}: provider-bound listing`)
    assert.match(source, /@contextmenu\.prevent\.stop="openFolderMenu\(\$event, crumb, index\)"/u, `${name}: right-click opens the menu`)
    assert.match(source, /:list-directory="listDirectory"/u, `${name}: menu uses the provider listing`)
    assert.match(source, /currentPath: currentChildPath\(breadcrumbs\.value, index\)/u, `${name}: current folder is marked`)
  }

  // The placeholder belongs to the breadcrumbs; it must not become the menu's v-else.
  assert.match(panel, /<\/nav>\s*<form v-else-if="address.editing"/u)
  assert.match(panel, /<span v-else class="panel-path">Loading…<\/span>/u)

  // Left click keeps its existing navigation in file panels.
  assert.match(panel, /@click\.stop="navigateToBreadcrumb\(crumb\)"/u)
  assert.match(panel, /openDirectory\(\{ \.\.\.folder, type: 'directory', isDirectory: true \}\)/u)
  // The editor tree browses locally; opened files keep the original tab context.
  assert.match(editor, /@select="browse\(\$event\.path\)"/u)
  assert.match(editor, /sourceRootPath: props\.context\.sourceRootPath,/u)
})
