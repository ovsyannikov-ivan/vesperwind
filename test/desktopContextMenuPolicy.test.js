import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { reactive, ref, withModifiers } from 'vue'
import { installDesktopContextMenuPolicy } from '../src/utils/desktopContextMenuPolicy.js'
import { currentChildPath } from '../src/utils/folderMenu.js'

const read = (path) => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const componentSources = new Map()
const component = (name) => {
  if (!componentSources.has(name)) componentSources.set(name, read(`src/components/${name}.vue`))
  return componentSources.get(name)
}

// Execute the production handlers with controlled state, without mounting the
// filesystem/backend or adding a DOM test dependency.
const handler = async (name, functionName, bindings) => {
  const { descriptor } = parse(await component(name))
  const { scriptSetupAst } = compileScript(descriptor, { id: name })
  const declaration = scriptSetupAst.flatMap((statement) => statement.declarations || [])
    .find((item) => item.id.name === functionName)
  assert.ok(declaration, `${name}.${functionName}`)
  const expression = descriptor.scriptSetup.content.slice(declaration.init.start, declaration.init.end)
  return new Function(...Object.keys(bindings), `return (${expression})`)(...Object.values(bindings))
}

class DocumentTarget extends EventTarget {
  listeners = []
  addEventListener(type, listener, capture) {
    this.listeners.push({ type, listener, capture })
    super.addEventListener(type, listener, { capture })
  }
  removeEventListener(type, listener, capture) {
    this.listeners = this.listeners.filter((entry) => entry.listener !== listener)
    super.removeEventListener(type, listener, { capture })
  }
}

const rightClick = (document, onTarget = () => {}) => {
  const event = new Event('contextmenu', { bubbles: true, cancelable: true })
  const calls = { prevent: 0, stop: 0, immediate: 0 }
  const preventDefault = event.preventDefault.bind(event)
  event.preventDefault = () => { calls.prevent++; preventDefault() }
  event.stopPropagation = () => { calls.stop++ }
  event.stopImmediatePropagation = () => { calls.immediate++ }
  Object.defineProperties(event, {
    clientX: { value: 120 }, clientY: { value: 80 },
  })
  document.dispatchEvent(event)
  // Document capture runs first. A global propagation stop must fail before
  // delivering the event to a component (whose own .stop remains valid).
  assert.equal(calls.stop, 0)
  assert.equal(calls.immediate, 0)
  onTarget(event)
  return { event, calls }
}

for (const mode of ['sea', 'tauri', 'browser']) {
  test(`${mode} runtime applies only the appropriate context-menu default policy`, () => {
    const target = new DocumentTarget()
    const dispose = installDesktopContextMenuPolicy({ target, runtimeState: reactive({ mode }) })
    try {
      const { event, calls } = rightClick(target)
      assert.equal(event.defaultPrevented, mode !== 'browser')
      assert.equal(calls.prevent, mode === 'browser' ? 0 : 1)
      assert.equal(target.listeners.length, mode === 'browser' ? 0 : 1)
      if (mode !== 'browser') assert.equal(target.listeners[0].capture, true)
    } finally { dispose() }
  })
}

test('asynchronous SEA discovery enables suppression and browser mode removes it', () => {
  const target = new DocumentTarget()
  const runtimeState = reactive({ mode: 'browser' })
  const dispose = installDesktopContextMenuPolicy({ target, runtimeState })
  assert.equal(rightClick(target).event.defaultPrevented, false)
  runtimeState.mode = 'sea'
  assert.equal(rightClick(target).event.defaultPrevented, true)
  runtimeState.mode = 'tauri'
  assert.equal(target.listeners.length, 1)
  runtimeState.mode = 'browser'
  assert.equal(rightClick(target).event.defaultPrevented, false)
  dispose()
  runtimeState.mode = 'sea'
  assert.equal(target.listeners.length, 0)
})

test('disposing a desktop policy removes its listener and watcher', () => {
  const target = new DocumentTarget()
  const runtimeState = reactive({ mode: 'tauri' })
  const dispose = installDesktopContextMenuPolicy({ target, runtimeState })
  dispose()
  dispose()
  runtimeState.mode = 'sea'
  assert.equal(rightClick(target).event.defaultPrevented, false)
  assert.equal(target.listeners.length, 0)
  assert.doesNotThrow(() => installDesktopContextMenuPolicy({ target: null })())
})

test('FileTree and SearchResults right-click still open the FileEntryContextMenu request', async () => {
  const target = new DocumentTarget()
  const dispose = installDesktopContextMenuPolicy({ target, runtimeState: reactive({ mode: 'tauri' }) })
  const entryContextRequest = ref(null)
  const openMenu = await handler('FileManager', 'openEntryContextMenu', {
    activePanel: ref('right'), entryContextBusy: ref(true), entryContextError: ref('old'), entryContextRequest,
  })
  const panelContext = await handler('FilePanel', 'openEntryContextMenu', {
    search: { open: true }, selectedEntries: ref([]), selectNode: () => {},
    entryContext: (payload) => ({ ...payload, sourcePane: 'left' }),
    emit: (eventName, payload) => { assert.equal(eventName, 'context-menu'); openMenu(payload) },
  })
  const emit = (eventName, payload) => { assert.equal(eventName, 'context-menu'); panelContext(payload) }
  try {
    for (const isDirectory of [false, true]) {
      const node = { name: 'Entry', path: '/Entry', isDirectory }
      const treeHandler = await handler('FileTreeNode', 'handleContextMenu', {
        cancelRenameTimer: () => {}, props: { node, depth: 1 }, selected: ref(true), selectNode: () => {}, emit,
      })
      const searchHandler = await handler('SearchResults', 'showContext', { emit })
      for (const onTarget of [treeHandler, (event) => searchHandler(event, node)]) {
        entryContextRequest.value = null
        assert.equal(rightClick(target, onTarget).event.defaultPrevented, true)
        assert.equal(entryContextRequest.value.node.path, node.path)
        assert.equal(entryContextRequest.value.node.isDirectory, isDirectory)
        assert.equal(entryContextRequest.value.sourcePane, 'left')
        assert.equal(entryContextRequest.value.x, 120)
        assert.equal(entryContextRequest.value.y, 80)
      }
    }
    assert.match(await component('FileTreeNode'), /@contextmenu="handleContextMenu"/)
    assert.match(await component('FileTree'), /@context-menu="\$emit\('context-menu', \$event\)"/)
    assert.match(await component('SearchResults'), /@contextmenu="showContext\(\$event, entry\)"/)
    assert.match(await component('FilePanel'), /@context-menu="openEntryContextMenu"/)
    assert.match(await component('FileManager'), /<FileEntryContextMenu\s+v-if="entryContextRequest"/)
    assert.match(await component('FileEntryContextMenu'), /@contextmenu\.prevent/)
  } finally { dispose() }
})

for (const name of ['FilePanel', 'EditorTree']) {
  test(`${name} breadcrumb right-click still opens FolderPathMenu after document capture`, async () => {
    const target = new DocumentTarget()
    const dispose = installDesktopContextMenuPolicy({ target, runtimeState: reactive({ mode: 'sea' }) })
    const folderMenu = ref(null)
    const crumbs = [{ path: '/Books', name: 'Books' }, { path: '/Books/Audio', name: 'Audio' }]
    const openFolderMenu = await handler(name, 'openFolderMenu', {
      folderMenu, folderMenuSequence: 0, breadcrumbs: ref(crumbs), currentChildPath,
    })
    try {
      const { event } = rightClick(target, (event) => {
        Object.defineProperty(event, 'currentTarget', {
          value: { getBoundingClientRect: () => ({ left: 20, bottom: 40 }) },
        })
        withModifiers((event) => openFolderMenu(event, crumbs[0], 0), ['prevent', 'stop'])(event)
      })
      assert.equal(event.defaultPrevented, true)
      assert.deepEqual(folderMenu.value, {
        id: 1, path: '/Books', name: 'Books', anchor: { left: 20, bottom: 40 }, currentPath: '/Books/Audio',
      })
      const source = await component(name)
      assert.match(source, /@contextmenu\.prevent\.stop="openFolderMenu\(\$event, crumb, index\)"/)
      assert.match(source, /<FolderPathMenu\s+v-if="folderMenu"[\s\S]*?:request="folderMenu"/)
      assert.match(await component('FolderPathMenu'), /@contextmenu\.prevent/)
    } finally { dispose() }
  })
}

test('both independent app documents install the same policy before mounting', async () => {
  const entries = ['src/main.js', 'src/media-overlay/main.js']
  for (const entry of entries) {
    const source = await read(entry)
    assert.match(source, /import \{ installDesktopContextMenuPolicy \} from '.*utils\/desktopContextMenuPolicy\.js'/)
    assert.match(source, /installDesktopContextMenuPolicy\(\)\s+void runtime\.getInfo\(\)\s+createApp\(/)
    assert.doesNotMatch(source, /addEventListener\(['"]contextmenu/)
    const target = new DocumentTarget()
    const dispose = installDesktopContextMenuPolicy({ target, runtimeState: reactive({ mode: 'tauri' }) })
    assert.equal(rightClick(target).event.defaultPrevented, true, entry)
    dispose()
  }
  const config = await read('vite.config.js')
  const documents = [...config.matchAll(/new URL\("\.\/([^\"]+\.html)"/g)].map((match) => match[1])
  assert.deepEqual(documents.sort(), ['index.html', 'media-overlay.html'])
})
