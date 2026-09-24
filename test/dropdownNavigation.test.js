import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { navigateDropdown } from '../src/utils/dropdownNavigation.js'

test('dropdown keyboard navigation starts only after an arrow key', () => {
  const previousDocument = globalThis.document
  const items = Array.from({ length: 3 }, () => ({
    focus() { globalThis.document.activeElement = this },
  }))
  const menu = {
    contains: (element) => element === menu || items.includes(element),
    querySelectorAll: () => items,
  }
  globalThis.document = { activeElement: menu }
  let prevented = 0
  const event = (key) => ({ key, preventDefault() { prevented += 1 } })

  try {
    assert.equal(navigateDropdown(event('Enter'), menu), false)
    assert.equal(globalThis.document.activeElement, menu)
    assert.equal(navigateDropdown(event('ArrowDown'), menu), true)
    assert.equal(globalThis.document.activeElement, items[0])
    assert.equal(navigateDropdown(event('End'), menu), true)
    assert.equal(globalThis.document.activeElement, items[2])
    assert.equal(navigateDropdown(event('ArrowDown'), menu), true)
    assert.equal(globalThis.document.activeElement, items[0])
    assert.equal(navigateDropdown(event('ArrowUp'), menu), true)
    assert.equal(globalThis.document.activeElement, items[2])
    assert.equal(prevented, 4)
  } finally {
    globalThis.document = previousDocument
  }
})

test('all dropdown surfaces share primary interaction states and no item receives initial focus', async () => {
  const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const [styles, main, overlayMain, context, operation, terminal, toolbar] = await Promise.all([
    read('src/styles/dropdown.css'), read('src/main.js'), read('src/media-overlay/main.js'),
    read('src/components/FileEntryContextMenu.vue'), read('src/components/FileOperationMenu.vue'),
    read('src/components/TerminalPanel.vue'), read('src/components/Toolbar.vue'),
  ])

  assert.match(main, /import '\.\/styles\/dropdown\.css'/u)
  assert.match(overlayMain, /import '\.\.\/styles\/dropdown\.css'/u)
  assert.match(styles, /--bs-dropdown-link-hover-bg: var\(--bs-primary\)/u)
  assert.match(styles, /--bs-dropdown-link-active-bg: var\(--bs-primary\)/u)
  assert.match(styles, /padding: 0\.35rem/u)
  assert.match(styles, /\.dropdown-menu \.dropdown-item \{\s*border-radius: var\(--bs-border-radius-sm\)/u)
  assert.match(styles, /\.dropdown-menu \.dropdown-item:has\(> \.mdi\)/u)
  assert.match(styles, /\.dropdown-menu \.dropdown-item:not\(:disabled\):hover,[\s\S]*background-color: var\(--bs-primary\)/u)
  assert.match(styles, /\.dropdown-menu \.dropdown-item:not\(:disabled\):focus-visible \{[\s\S]*background-color: var\(--bs-primary\)/u)
  assert.match(styles, /\.dropdown-menu \.dropdown-item:focus \{[\s\S]*background-color: transparent/u)
  for (const menu of [context, operation, terminal]) {
    assert.match(menu, /navigateDropdown\(event, menuRef\.value\)/u)
    assert.match(menu, /menuRef\.value\?\.focus\(\{ preventScroll: true \}\)/u)
    assert.doesNotMatch(menu, /firstActionRef\.value\?\.focus/u)
  }
  assert.match(toolbar, /class="dropdown-menu toolbar-create-menu shadow"/u)
  assert.match(terminal, /<h2 class="dropdown-header">Remote<\/h2>/u)
  assert.match(toolbar, /document\.addEventListener\('pointerdown', closeCreateOnOutsidePointer, true\)/u)
  assert.match(toolbar, /!createButton\.value\?\.contains\(event\.target\) && !createMenu\.value\?\.contains\(event\.target\)/u)
  assert.match(toolbar, /createDropdown\?\.hide\(\)/u)
})
