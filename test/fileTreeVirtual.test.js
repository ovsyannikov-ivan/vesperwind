// Mounts the real FileTree and FileTreeNode components with Vue's renderer
// on a small element tree, to check windowing, row reuse and the behaviour
// that depends on unmounted rows.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { h, nextTick, reactive, ref } from 'vue'
import { compileComponent, FakeElement, installDomGlobals, testRenderer } from './support/vueTestRenderer.js'
import { answerBatch, cloudBackend, resetCloudBackend } from './support/fakeCloudStatus.js'
import { selectFileEntries } from '../src/utils/fileSelection.js'

installDomGlobals()
const nodeUrl = await compileComponent('src/components/FileTreeNode.vue')
const treeUrl = await compileComponent('src/components/FileTree.vue', { './FileTreeNode.vue': nodeUrl,
  '../api/cloudStatus.js': new URL('./support/fakeCloudStatus.js', import.meta.url).href })
const { default: FileTree } = await import(treeUrl)

const ROW = 22
const VIEWPORT = 440
const OFFSET = 25
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const file = (dir, index) => ({ name: `file-${String(index).padStart(5, '0')}.txt`, path: `${dir}/file-${String(index).padStart(5, '0')}.txt`,
  isDirectory: false, size: index, modifiedAt: '2026-10-11T00:00:00.000Z' })

const mountTree = async ({ count = 3000, folders = null, compact = false, cloud = false } = {}) => {
  resetCloudBackend(cloud)
  const directories = folders || { '/root': Array.from({ length: count }, (_, index) => file('/root', index)) }
  const requests = []
  const container = new FakeElement('div')
  container.scrollContainer = true
  container.clientHeight = VIEWPORT
  container.box = () => ({ top: 0, bottom: VIEWPORT })
  const host = new FakeElement('div')
  host.childBox = () => ({ top: OFFSET - container.scrollTop })
  container.children.push(host); host.parentNode = container
  const state = reactive({ selectedPath: '/root', selectedEntries: [], anchorPath: '', expandedPaths: [], refreshRevision: 0, hide: null })
  const events = []
  const treeRef = ref(null)
  const select = ({ node, shiftKey, metaKey, ctrlKey }) => {
    const clicked = { ...node, providerId: 'local' }
    const next = selectFileEntries({ entries: state.selectedEntries, anchorPath: state.anchorPath, clicked,
      visibleEntries: treeRef.value.visibleEntries(), shiftKey, additiveKey: metaKey || ctrlKey })
    Object.assign(state, { selectedEntries: next.entries, anchorPath: next.anchorPath, selectedPath: next.active?.path || '' })
  }
  const app = testRenderer.createApp({
    render: () => h(FileTree, {
      ref: treeRef,
      root: { name: 'root', path: '/root', isDirectory: true },
      panelSide: 'left',
      providerId: 'local',
      // Watchers are covered by the tree state tests; no backend runs here.
      watchActive: false,
      selectedPath: state.selectedPath,
      selectedPaths: state.selectedEntries.map((entry) => entry.path),
      selectedEntries: state.selectedEntries,
      expandedPaths: state.expandedPaths,
      compact,
      scrollSelectedIntoView: compact,
      refreshRevision: state.refreshRevision,
      transformChildren: state.hide ? (entries) => entries.filter((entry) => !state.hide(entry)) : null,
      listDirectory: async (path) => {
        requests.push(path)
        return { ok: true, entries: (directories[path] || []).map((entry) => ({ ...entry })) }
      },
      onSelect: select,
      onContextMenu: (payload) => events.push(['context-menu', payload]),
      onOpen: (payload) => events.push(['open', payload]),
      onExpandedChange: ({ path, expanded }) => {
        state.expandedPaths = expanded ? [...state.expandedPaths, path] : state.expandedPaths.filter((value) => value !== path)
      },
    }),
  })
  app.mount(host)
  await settle(); await nextTick()
  const list = host.querySelector('UL')
  const rows = () => list.querySelectorAll('.tree-row')
  const scrollTo = async (top) => {
    container.scrollTop = top
    container.dispatchEvent({ type: 'scroll', bubbles: false })
    await settle(120)
    await nextTick()
  }
  const key = async (target, name, extra = {}) => {
    target.dispatchEvent({ type: 'keydown', key: name, bubbles: true, target, preventDefault () {}, ...extra })
    await settle(); await nextTick(); await nextTick()
  }
  // Tab stops by name: elements are compared by identity, never deeply.
  const tabStops = () => [list, ...rows()].filter((element) => element.getAttribute('tabindex') === '0')
    .map((element) => (element === list ? 'list' : element.dataset.treePath))
  return { app, list, rows, scrollTo, container, state, requests, events, directories, key, tabStops, tree: () => treeRef.value }
}

test('3000 and 10,000 entries mount only the viewport plus overscan', async () => {
  for (const count of [3000, 10_000]) {
    const h = await mountTree({ count })
    const mounted = h.rows().length
    assert.ok(mounted <= Math.ceil(VIEWPORT / ROW) + 1 + 12, `${count} entries mounted ${mounted} rows`)
    assert.equal(h.tree().visibleEntries().length, count, 'all entries stay in the logical tree')
    const spacers = h.list.querySelectorAll('.tree-spacer')
    assert.equal(spacers.length, 1, 'only a bottom spacer at the start')
    assert.equal(Number.parseInt(spacers[0].style.height), (count + 1 - mounted) * ROW)
    assert.equal(spacers[0].getAttribute('aria-hidden'), 'true')
    assert.equal(spacers[0].getAttribute('role'), 'none')
    h.app.unmount()
  }
})

test('scrolling replaces rows without accumulating DOM, reuses overlapping rows and never reloads', async () => {
  const h = await mountTree()
  const requests = h.requests.length
  await h.scrollTo(1500 * ROW)
  const paths = h.rows().map((row) => row.dataset.filePath)
  assert.ok(paths.includes('/root/file-01499.txt'), 'the row at the viewport top is mounted')
  assert.ok(!paths.includes('/root/file-00000.txt'), 'rows far above were unmounted')
  const spacers = h.list.querySelectorAll('.tree-spacer')
  assert.equal(spacers.length, 2)
  const total = spacers.reduce((sum, spacer) => sum + Number.parseInt(spacer.style.height), 0) + h.rows().length * ROW
  assert.equal(total, 3001 * ROW, 'the scroll height stays the full logical height')
  const kept = h.rows().find((row) => row.dataset.filePath === '/root/file-01505.txt')
  await h.scrollTo(1500 * ROW + 3 * ROW)
  assert.equal(h.rows().find((row) => row.dataset.filePath === '/root/file-01505.txt'), kept, 'a row that stays in range is reused')
  for (const top of [0, 60_000, 12_345, 66_000]) await h.scrollTo(top)
  assert.ok(h.rows().length <= Math.ceil(VIEWPORT / ROW) + 1 + 24)
  assert.equal(h.requests.length, requests, 'scrolling never lists a folder')
  h.app.unmount()
})

test('Shift-click selects across 1500 rows that were never mounted', async () => {
  const h = await mountTree()
  h.rows().find((row) => row.dataset.filePath === '/root/file-00000.txt').dispatchEvent({ type: 'click', bubbles: true })
  await nextTick()
  await h.scrollTo(1490 * ROW)
  h.rows().find((row) => row.dataset.filePath === '/root/file-01499.txt').dispatchEvent({ type: 'click', bubbles: true, shiftKey: true })
  await nextTick()
  assert.equal(h.state.selectedEntries.length, 1500)
  assert.equal(h.state.selectedEntries.at(-1).path, '/root/file-01499.txt')
  const selectedInDom = h.rows().filter((row) => row.classList.contains('is-selected'))
  assert.ok(selectedInDom.length < 1500)
  h.app.unmount()
})

test('a rename keeps its draft and caret while its row scrolls away and back', async () => {
  const h = await mountTree()
  const target = h.tree().tree.rows.value[2000].entry
  h.state.selectedPath = target.path
  await nextTick()
  // Rename of an unmounted entry first scrolls to it.
  h.container.scrollTop = 0
  await h.tree().revealPath(target.path)
  h.tree().tree.beginRename(target)
  h.container.dispatchEvent({ type: 'scroll' })
  await settle(120); await nextTick(); await nextTick()
  let input = h.list.querySelector('.tree-rename-input')
  assert.ok(input, 'the input is mounted in its row')
  assert.equal(globalThis.document.activeElement, input)
  input.value = 'draft.txt'
  input.dispatchEvent({ type: 'input', bubbles: true, target: input })
  input.selectionStart = 2; input.selectionEnd = 5
  input.dispatchEvent({ type: 'keyup', bubbles: false, target: input })
  await h.scrollTo(0)
  assert.equal(h.list.querySelector('.tree-rename-input'), null, 'the row left the window')
  assert.equal(h.tree().tree.rename.path, target.path, 'the rename is still in progress')
  await h.scrollTo(2000 * ROW)
  await nextTick()
  input = h.list.querySelector('.tree-rename-input')
  assert.equal(input.value, 'draft.txt')
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5])
  assert.equal(globalThis.document.activeElement, input)
  h.app.unmount()
})

test('context menu and open use the logical folder entries, not mounted rows', async () => {
  const h = await mountTree()
  const row = h.rows()[3]
  row.dispatchEvent({ type: 'contextmenu', bubbles: true, clientX: 1, clientY: 2, preventDefault () {}, stopPropagation () {} })
  row.dispatchEvent({ type: 'dblclick', bubbles: true })
  const [[, menu], [, open]] = h.events
  assert.equal(menu.siblings.length, 3000)
  assert.equal(open.siblings.length, 3000)
  assert.equal(open.node.path, row.dataset.filePath)
  h.app.unmount()
})

test('rows carry tree semantics; spacers are hidden and only one row is a tab stop', async () => {
  const h = await mountTree({ folders: {
    '/root': [{ name: 'dir', path: '/root/dir', isDirectory: true }, file('/root', 1), file('/root', 2)],
    '/root/dir': [],
  } })
  const items = h.list.querySelectorAll('LI').filter((item) => item.getAttribute('role') === 'treeitem')
  assert.deepEqual(items.map((item) => [item.getAttribute('aria-level'), item.getAttribute('aria-posinset'), item.getAttribute('aria-setsize')]),
    [['1', '1', '1'], ['2', '1', '3'], ['2', '2', '3'], ['2', '3', '3']])
  assert.equal(items[1].getAttribute('aria-expanded'), 'false')
  assert.equal(h.rows().filter((row) => row.getAttribute('tabindex') === '0').length, 1)
  assert.equal(h.list.getAttribute('role'), 'tree')
  h.rows()[1].querySelector('.tree-toggle').dispatchEvent({ type: 'click', bubbles: true, stopPropagation () {} })
  await settle(); await nextTick()
  const text = (node) => node.children ? node.children.map(text).join('') : node.textContent || ''
  assert.deepEqual(h.list.querySelectorAll('.tree-state').map((state) => text(state).trim()), ['Empty folder'])
  assert.equal(h.list.querySelectorAll('LI').filter((item) => item.getAttribute('role') === 'treeitem')[1].getAttribute('aria-expanded'), 'true')
  h.app.unmount()
})

const rowFor = (h, index) => h.rows().find((row) => row.dataset.filePath === `/root/file-${String(index).padStart(5, '0')}.txt`)
const click = async (element, extra = {}) => { element.dispatchEvent({ type: 'click', bubbles: true, ...extra }); await nextTick() }

for (const compact of [false, true]) {
  test(`${compact ? 'editor' : 'panel'} tree: Tab still reaches the tree after the selected row scrolls away`, async () => {
    const h = await mountTree({ compact })
    assert.deepEqual(h.tabStops(), ['/root'], 'the selected root row is the tab stop')
    await click(rowFor(h, 0))
    rowFor(h, 0).focus()
    await h.scrollTo(1500 * ROW)
    assert.ok(rowFor(h, 0) === undefined, 'the selected row left the window')
    assert.deepEqual(h.tabStops(), ['list'], 'the list is the single tab stop')
    assert.ok(globalThis.document.activeElement === h.list, 'focus moved to the list instead of being lost')
    assert.equal(h.state.selectedPath, '/root/file-00000.txt', 'scrolling did not change the selection')
    assert.equal(h.container.scrollTop, 1500 * ROW, 'and did not scroll back')
    // Keys on the list work on the logical selection.
    await h.key(h.list, 'ArrowDown')
    assert.equal(h.state.selectedPath, '/root/file-00001.txt')
    assert.ok(globalThis.document.activeElement === rowFor(h, 1), 'the new row is revealed and focused')
    assert.deepEqual(h.tabStops(), ['/root/file-00001.txt'])
    if (!compact) {
      await h.key(rowFor(h, 1), 'ArrowDown', { shiftKey: true })
      await h.key(rowFor(h, 2), 'ArrowDown', { shiftKey: true })
      assert.equal(h.state.anchorPath, '/root/file-00001.txt', 'Shift keeps the anchor')
      assert.deepEqual(h.state.selectedEntries.map((entry) => entry.name), ['file-00001.txt', 'file-00002.txt', 'file-00003.txt'])
    }
    await h.key(globalThis.document.activeElement, 'End')
    assert.equal(h.state.selectedPath, '/root/file-02999.txt')
    h.app.unmount()
  })
}

test('F2 and Enter on the list act on an offscreen selection; the draft survives scrolling', async () => {
  const h = await mountTree()
  await click(rowFor(h, 3))
  rowFor(h, 3).focus()
  await h.scrollTo(2000 * ROW)
  assert.ok(globalThis.document.activeElement === h.list)
  await h.key(h.list, 'F2')
  await settle(); await nextTick()
  const input = h.list.querySelector('.tree-rename-input')
  assert.ok(input, 'the rename starts on the selected row, scrolled into view')
  assert.equal(input.closest('.tree-row').dataset.filePath, '/root/file-00003.txt')
  assert.ok(globalThis.document.activeElement === input)
  input.value = 'kept.txt'
  input.dispatchEvent({ type: 'input', bubbles: true, target: input })
  await h.scrollTo(2500 * ROW)
  assert.ok(globalThis.document.activeElement === h.list, 'the unmounted input hands focus to the list')
  assert.equal(h.tree().tree.rename.draft, 'kept.txt')
  h.app.unmount()
})

test('focus moves to the list when the focused row is deleted or filtered out', async () => {
  const h = await mountTree({ count: 20 })
  await click(rowFor(h, 5))
  rowFor(h, 5).focus()
  h.directories['/root'] = h.directories['/root'].filter((entry) => entry.name !== 'file-00005.txt')
  h.state.refreshRevision++
  await settle(); await nextTick()
  assert.equal(rowFor(h, 5), undefined)
  assert.ok(globalThis.document.activeElement === h.list)
  assert.equal(h.tabStops().length, 1)
  await click(rowFor(h, 7))
  rowFor(h, 7).focus()
  h.state.hide = (entry) => entry.name === 'file-00007.txt'
  await nextTick(); await nextTick()
  assert.equal(rowFor(h, 7), undefined)
  assert.ok(globalThis.document.activeElement === h.list)
  assert.equal(h.tabStops().length, 1)
  h.app.unmount()
})

test('rows render before cloud status; the next batch follows the real viewport', async () => {
  const h = await mountTree({ cloud: true })
  assert.ok(h.rows().length > 20, 'rows are shown while the first batch is pending')
  assert.equal(cloudBackend.sent.length, 1)
  const [first] = cloudBackend.sent
  assert.equal(first.paths.length, 64)
  const onScreen = Array.from({ length: 19 }, (_, index) => `/root/file-${String(index).padStart(5, '0')}.txt`)
  assert.ok(onScreen.every((path) => first.paths.slice(0, 19).includes(path)), 'the first batch starts with the rows on screen')
  await h.scrollTo(1500 * ROW)
  answerBatch(0)
  await settle(); await nextTick()
  const second = cloudBackend.sent[1].paths.map((path) => Number(path.match(/(\d+)\.txt$/)[1]))
  assert.ok(second.every((index) => Math.abs(index - 1508) <= 40), `the second batch is around the viewport: ${second.slice(0, 5)}`)
  assert.equal(cloudBackend.sent.length, 2, 'scrolling did not restart the scan')
  assert.deepEqual(cloudBackend.other, [], 'nothing but metadata was requested')
  // Badges come from the tree state when rows come back.
  await h.scrollTo(0)
  const badges = h.rows().slice(1, 6).map((row) => row.querySelector('.tree-content-badge')?.getAttribute('aria-label') || null)
  assert.ok(badges.every((label) => /download required/.test(label)), 'resolved badges reappear without a new request')
  assert.equal(cloudBackend.sent.length, 2)
  assert.equal(h.requests.length, 1, 'no new listing')
  h.app.unmount()
  assert.ok(cloudBackend.cancelled.length >= 1, 'unmounting cancels the batch in flight')
})

// The transport modules imported by the rows keep the event loop alive.
after(() => setImmediate(() => process.exit(process.exitCode ?? 0)))
