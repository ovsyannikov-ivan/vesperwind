import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effect, nextTick, reactive } from 'vue'
import { COLLAPSED_DIRECTORY_LIMIT, createDirectoryTree } from '../src/composables/useDirectoryTree.js'
import { flattenTree } from '../src/utils/flattenTree.js'
import { computeVirtualRange, scrollTopForIndex } from '../src/utils/virtualRange.js'
import { sortAndFilterEntries } from '../src/utils/fileDirectoryView.js'
import { selectFileEntries } from '../src/utils/fileSelection.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const file = (dir, name, extra = {}) => ({ name, path: `${dir}/${name}`, isDirectory: false, size: 1, modifiedAt: '2026-10-11T00:00:00.000Z', ...extra })
const folder = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: true, size: null, modifiedAt: '2026-10-11T00:00:00.000Z' })
const many = (dir, count, prefix = 'file') => Array.from({ length: count }, (_, index) => file(dir, `${prefix}-${String(index).padStart(5, '0')}.txt`, { size: index }))

// A folder tree served from memory, counting requests and live watchers.
const fixture = (folders, options = {}) => {
  const calls = []
  const watchers = new Map()
  const props = reactive({ providerId: 'local', root: { name: 'root', path: '/root', isDirectory: true }, expandedPaths: [],
    view: { name: '', extensions: [], keepFolders: true, sort: 'name', direction: 'asc' }, watchActive: true, ...options.props })
  const events = { loaded: [], expanded: [] }
  const tree = createDirectoryTree({
    getRoot: () => props.root,
    getProviderId: () => props.providerId,
    listDirectory: async (path) => {
      calls.push(path)
      if (options.listDelay) await options.listDelay(path)
      const entries = folders[path]
      return entries ? { ok: true, entries: entries.map((entry) => ({ ...entry })) } : { ok: false, error: { message: 'Missing' } }
    },
    transformChildren: (entries, depth) => sortAndFilterEntries(entries, props.view, depth),
    getExpandedPaths: () => props.expandedPaths,
    isWatchActive: () => props.watchActive,
    watchRegistry: {
      subscribe: (providerId, path, callback) => {
        const key = `${providerId}:${path}`
        watchers.set(key, callback)
        return () => watchers.delete(key)
      },
    },
    onChildrenLoaded: (payload) => events.loaded.push(payload.path),
    onExpandedChange: (payload) => {
      events.expanded.push(payload)
      props.expandedPaths = payload.expanded ? [...new Set([...props.expandedPaths, payload.path])] : props.expandedPaths.filter((path) => path !== payload.path)
    },
  })
  const names = () => tree.rows.value.map((row) => `${'  '.repeat(row.depth)}${row.kind === 'entry' ? row.entry.name : `<${row.kind}>`}`)
  return { tree, props, calls, watchers, events, names }
}

const nestedFolders = () => ({
  '/root': [file('/root', 'b.pdf'), folder('/root', 'Documents'), file('/root', 'a.txt'), folder('/root', 'Downloads')],
  '/root/Documents': [folder('/root/Documents', 'Projects'), file('/root/Documents', 'notes.md')],
  '/root/Documents/Projects': [folder('/root/Documents/Projects', 'Vesperwind')],
  '/root/Documents/Projects/Vesperwind': [file('/root/Documents/Projects/Vesperwind', 'README.md'), file('/root/Documents/Projects/Vesperwind', 'package.json')],
  '/root/Downloads': [],
})

test('the expanded tree flattens into ordered rows with depth, parent and set position', async () => {
  const h = fixture(nestedFolders())
  h.tree.resetRoot(); await settle()
  assert.deepEqual(h.events.expanded, [], 'the root opens without becoming an expanded path')
  const documents = h.tree.rows.value.find((row) => row.entry?.name === 'Documents')
  h.tree.expand(documents.entry, documents.depth + 1 - 1); await settle()
  const projects = h.tree.rows.value.find((row) => row.entry?.name === 'Projects')
  h.tree.expand(projects.entry, projects.depth); await settle()
  const vesperwind = h.tree.rows.value.find((row) => row.entry?.name === 'Vesperwind')
  h.tree.expand(vesperwind.entry, vesperwind.depth); await settle()
  const downloads = h.tree.rows.value.find((row) => row.entry?.name === 'Downloads')
  h.tree.expand(downloads.entry, downloads.depth); await settle()
  assert.deepEqual(h.names(), [
    'root',
    '  Documents',
    '    Projects',
    '      Vesperwind',
    '        package.json',
    '        README.md',
    '    notes.md',
    '  Downloads',
    '    <empty>',
    '  a.txt',
    '  b.pdf',
  ])
  const readme = h.tree.rows.value.find((row) => row.entry?.name === 'README.md')
  assert.equal(readme.parentPath, '/root/Documents/Projects/Vesperwind')
  assert.deepEqual([readme.posInSet, readme.setSize], [2, 2])
  assert.equal(h.tree.indexOf('/root/b.pdf'), 10)
  assert.deepEqual(h.events.expanded.map((event) => event.path), ['/root/Documents', '/root/Documents/Projects', '/root/Documents/Projects/Vesperwind', '/root/Downloads'])
  h.tree.dispose()
})

test('collapsing hides descendants and keeps the folder data; reopening needs no new request', async () => {
  const h = fixture(nestedFolders())
  h.tree.resetRoot(); await settle()
  const documents = () => h.tree.rows.value.find((row) => row.entry?.name === 'Documents')
  h.tree.expand(documents().entry, 1); await settle()
  h.tree.expand(h.tree.rows.value.find((row) => row.entry?.name === 'Projects').entry, 2); await settle()
  assert.equal(h.watchers.size, 3)
  const requests = h.calls.length
  h.tree.collapse('/root/Documents')
  assert.deepEqual(h.names(), ['root', '  Documents', '  Downloads', '  a.txt', '  b.pdf'])
  assert.equal(h.watchers.size, 1, 'collapsed folders stop watching')
  assert.equal(h.tree.recordOf('/root/Documents/Projects'), undefined, 'descendants are released')
  assert.ok(h.tree.recordOf('/root/Documents'), 'the collapsed folder keeps its contents')
  // Reopening restores Projects from expandedPaths, like remounted rows did.
  h.props.expandedPaths = [...h.props.expandedPaths, '/root/Documents/Projects']
  h.tree.expand(documents().entry, 1); await settle()
  assert.equal(h.calls.filter((path) => path === '/root/Documents').length, 1, 'cached contents, no reload')
  assert.ok(h.names().includes('      Vesperwind'))
  assert.equal(h.calls.length, requests + 1, 'only the released subfolder is read again')
  h.tree.dispose()
  assert.equal(h.watchers.size, 0)
})

test('collapsed folder data is bounded', async () => {
  const folders = { '/root': Array.from({ length: COLLAPSED_DIRECTORY_LIMIT + 10 }, (_, index) => folder('/root', `d${String(index).padStart(3, '0')}`)) }
  for (const entry of folders['/root']) folders[entry.path] = [file(entry.path, 'x.txt')]
  const h = fixture(folders)
  h.tree.resetRoot(); await settle()
  for (const entry of folders['/root']) { h.tree.expand(entry, 1); await settle(); h.tree.collapse(entry.path) }
  assert.equal(h.tree.recordCount(), COLLAPSED_DIRECTORY_LIMIT + 1)
  assert.equal(h.tree.recordOf('/root/d000'), undefined, 'the oldest collapsed folder was released')
  assert.ok(h.tree.recordOf(`/root/d${String(COLLAPSED_DIRECTORY_LIMIT + 9).padStart(3, '0')}`))
  h.tree.dispose()
})

test('filter and sort run on the whole folder, independent of the DOM and without new requests', async () => {
  const entries = [...many('/root', 2990), ...Array.from({ length: 10 }, (_, index) => file('/root', `doc-${index}.pdf`, { size: 10_000 - index }))]
  const h = fixture({ '/root': entries })
  h.tree.resetRoot(); await settle()
  assert.equal(h.tree.rows.value.length, 3001)
  const requests = h.calls.length
  h.props.view = { ...h.props.view, name: '*.pdf', sort: 'size', direction: 'asc' }
  assert.deepEqual(h.tree.rows.value.slice(1).map((row) => row.entry.name), Array.from({ length: 10 }, (_, index) => `doc-${9 - index}.pdf`))
  h.props.view = { ...h.props.view, name: '', extensions: ['.pdf'], direction: 'desc' }
  assert.equal(h.tree.rows.value[1].entry.name, 'doc-0.pdf')
  h.props.view = { ...h.props.view, extensions: [] }
  assert.equal(h.tree.rows.value.length, 3001)
  assert.equal(h.calls.length, requests)
  h.tree.dispose()
})

test('nested folders keep their own sort and are never filtered', async () => {
  const h = fixture({
    '/root': [folder('/root', 'sub'), file('/root', 'x.pdf'), file('/root', 'y.txt')],
    '/root/sub': [file('/root/sub', 'b.txt', { size: 1 }), file('/root/sub', 'a.txt', { size: 2 })],
  }, { props: { expandedPaths: ['/root/sub'] } })
  h.props.view = { ...h.props.view, extensions: ['.pdf'], sort: 'size', direction: 'desc' }
  h.tree.resetRoot(); await settle(); await settle()
  assert.deepEqual(h.names(), ['root', '  sub', '    a.txt', '    b.txt', '  x.pdf'])
  h.tree.dispose()
})

test('a cloud badge update does not re-flatten or re-sort the tree', async () => {
  const h = fixture({ '/root': many('/root', 3000) })
  h.tree.resetRoot(); await settle()
  let flattens = 0
  const runner = effect(() => { flattens++; void h.tree.rows.value })
  const before = flattens
  h.tree.rows.value[1500].entry.contentAvailability = { state: 'cloud' }
  await nextTick()
  assert.equal(flattens, before)
  runner.effect.stop()
  h.tree.dispose()
})

test('watcher refreshes rebuild rows from the folder data and drop removed entries', async () => {
  const folders = { '/root': many('/root', 5) }
  const h = fixture(folders)
  h.tree.resetRoot(); await settle()
  folders['/root'] = [...folders['/root'].slice(1), file('/root', 'renamed.txt')]
  h.watchers.get('local:/root')()
  await settle()
  assert.deepEqual(h.tree.rows.value.slice(1).map((row) => row.entry.name), ['file-00001.txt', 'file-00002.txt', 'file-00003.txt', 'file-00004.txt', 'renamed.txt'])
  assert.deepEqual(h.events.loaded, ['/root', '/root'])
  h.tree.dispose()
})

test('deactivating keeps data but stops watching; reactivating refreshes; provider change releases everything', async () => {
  const h = fixture(nestedFolders())
  h.tree.resetRoot(); await settle()
  h.tree.expand(h.tree.rows.value.find((row) => row.entry?.name === 'Documents').entry, 1); await settle()
  h.tree.setWatchActive(false)
  assert.equal(h.watchers.size, 0)
  assert.ok(h.tree.rows.value.length > 5)
  const requests = h.calls.length
  h.props.watchActive = true
  h.tree.setWatchActive(true); await settle()
  assert.equal(h.watchers.size, 2)
  assert.equal(h.calls.length, requests + 2)
  h.props.providerId = 'sftp:server'
  h.tree.resetRoot()
  assert.equal(h.watchers.has('local:/root'), false)
  assert.equal(h.tree.recordOf('/root/Documents'), undefined)
  h.tree.dispose()
})

test('a late listing of a collapsed folder does not reopen or change it', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = fixture(nestedFolders(), { listDelay: (path) => (path === '/root/Documents' ? gate : null) })
  h.tree.resetRoot(); await settle()
  h.tree.expand(h.tree.rows.value.find((row) => row.entry?.name === 'Documents').entry, 1)
  h.tree.collapse('/root/Documents')
  release(); await settle()
  assert.equal(h.tree.isExpanded('/root/Documents'), false)
  assert.equal(h.tree.recordOf('/root/Documents').state.loaded, false)
  assert.deepEqual(h.names(), ['root', '  Documents', '  Downloads', '  a.txt', '  b.pdf'])
  h.tree.dispose()
})

test('the rename draft belongs to the tree, not to a mounted row', async () => {
  const h = fixture({ '/root': many('/root', 3) })
  h.tree.resetRoot(); await settle()
  h.tree.beginRename(h.tree.rows.value[2].entry)
  h.tree.rename.draft = 'typed while scrolled away.txt'
  h.tree.rename.error = 'This name is already used'
  assert.equal(h.tree.rows.value[3].kind, 'rename-error')
  assert.equal(h.tree.rename.draft, 'typed while scrolled away.txt')
  h.tree.rename.busy = true
  h.tree.cancelRename()
  assert.equal(h.tree.rename.path, '/root/file-00001.txt', 'a running rename is not cancelled')
  h.tree.rename.busy = false
  h.tree.cancelRename()
  assert.equal(h.tree.rename.path, '')
  h.tree.dispose()
})

test('flattenTree reads only loaded data and shows error and filtered-empty states', () => {
  const directories = new Map([
    ['/r', { state: { loaded: true, error: null, sourceEntryCount: 2 }, displayed: [folder('/r', 'open'), folder('/r', 'closed'), folder('/r', 'unloaded')] }],
    ['/r/open', { state: { loaded: true, error: { message: 'Offline' }, sourceEntryCount: 1 }, displayed: [file('/r/open', 'kept.txt')] }],
    ['/r/unloaded', { state: { loaded: true, error: null, sourceEntryCount: 4 }, displayed: [] }],
  ])
  const asked = []
  const { rows } = flattenTree({
    root: { name: 'r', path: '/r', isDirectory: true },
    isExpanded: (path) => path !== '/r/closed',
    directoryOf: (path) => { asked.push(path); return directories.get(path) || null },
  })
  assert.deepEqual(rows.map((row) => `${row.depth}:${row.kind}:${row.entry?.name ?? row.message}`), [
    '0:entry:r', '1:entry:open', '2:error:Offline', '2:entry:kept.txt', '1:entry:closed', '1:entry:unloaded', '2:empty:No items match the current filters',
  ])
  assert.equal(asked.includes('/r/closed'), false, 'a closed folder is never asked for')
})

test('virtual range covers the viewport plus overscan, clamps at both ends and is empty for no rows', () => {
  const base = { rowHeight: 22, viewportHeight: 440, offset: 25, inset: 25, overscan: 12 }
  assert.deepEqual(computeVirtualRange({ ...base, count: 3000, scrollTop: 0 }), { start: 0, end: 31, first: 0, last: 18 })
  const middle = computeVirtualRange({ ...base, count: 3000, scrollTop: 33_000 })
  assert.equal(middle.first, 1500)
  assert.deepEqual([middle.start, middle.end], [1488, 1531])
  const end = computeVirtualRange({ ...base, count: 3000, scrollTop: 3000 * 22 })
  assert.deepEqual([end.end, end.last], [3000, 2999])
  assert.deepEqual(computeVirtualRange({ ...base, count: 0 }), { start: 0, end: 0, first: 0, last: -1 })
  for (const count of [3000, 10_000, 50_000]) {
    const range = computeVirtualRange({ ...base, count, scrollTop: count * 11 })
    assert.ok(range.end - range.start <= Math.ceil(440 / 22) + 1 + 24, `${count} rows mount ${range.end - range.start}`)
  }
  const resized = computeVirtualRange({ ...base, count: 3000, scrollTop: 0, viewportHeight: 880 })
  assert.equal(resized.last, 38)
})

test('scrolling to an index brings it fully below the sticky header or above the bottom', () => {
  const base = { rowHeight: 22, viewportHeight: 440, offset: 25, inset: 25 }
  assert.equal(scrollTopForIndex({ ...base, index: 1500, scrollTop: 0 }), 25 + 1501 * 22 - 440)
  assert.equal(scrollTopForIndex({ ...base, index: 3, scrollTop: 1000 }), 25 + 3 * 22 - 25)
  assert.equal(scrollTopForIndex({ ...base, index: 5, scrollTop: 0 }), null)
})

test('Shift selection spans logical rows that were never mounted', async () => {
  const h = fixture({ '/root': many('/root', 3000) })
  h.tree.resetRoot(); await settle()
  const visible = h.tree.rows.value.filter((row) => row.depth > 0).map((row) => ({ ...row.entry, providerId: 'local' }))
  const first = visible[0]
  const target = visible[1499]
  const next = selectFileEntries({ entries: [first], anchorPath: first.path, clicked: target, visibleEntries: visible, shiftKey: true })
  assert.equal(next.entries.length, 1500)
  assert.equal(next.entries.at(-1).path, target.path)
  h.tree.dispose()
})

test('the panel restores expanded folders after a swap once their parents load', async () => {
  const h = fixture(nestedFolders(), { props: { expandedPaths: ['/root/Documents', '/root/Documents/Projects'] } })
  h.tree.resetRoot(); await settle(); await settle(); await settle()
  assert.ok(h.names().includes('      Vesperwind'))
  // Vesperwind itself was not expanded, so its files stay hidden.
  assert.equal(computed(() => h.tree.rows.value.length).value, 8)
  h.tree.dispose()
})
