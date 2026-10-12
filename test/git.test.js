import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitViewer } from '../src/composables/useGitViewer.js'
import { createGitWatchRegistry as frontendRegistry } from '../src/api/gitWatch.js'
import { discoverListedRepositories } from '../src/api/git.js'

const fixture = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-git-')),
)
process.env.FILE_MANAGER_ROOT = fixture
const { gitOperation, detectRepositories, repositoryDirectories } =
  await import('../server/git.js')
const { createGitWatchRegistry } = await import('../server/gitWatch.js')
const command = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const makeRepo = async (name) => {
  const root = path.join(fixture, name)
  await fs.mkdir(root)
  command(root, 'init', '-b', 'main')
  command(root, 'config', 'user.name', 'Git Test')
  command(root, 'config', 'user.email', 'test@example.test')
  return root
}
const request = (operation, root, extra = {}) =>
  gitOperation(operation, { filesystemId: 'local', path: root, ...extra })
const waitFor = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Git event timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
test.after(() => fs.rm(fixture, { recursive: true, force: true }))

test('batched discovery identifies roots, nested repos and .git worktree files, never ordinary subfolders', async () => {
  const root = await makeRepo('discovery')
  await fs.mkdir(path.join(root, 'ordinary'))
  await fs.writeFile(path.join(root, 'a.txt'), 'first\n')
  command(root, 'add', '.')
  command(root, 'commit', '-m', 'initial')
  const nested = path.join(root, 'nested')
  await fs.mkdir(nested)
  command(nested, 'init')
  const worktree = path.join(fixture, 'worktree')
  command(root, 'worktree', 'add', '-b', 'other', worktree)
  const repos = await detectRepositories([
    root,
    path.join(root, 'ordinary'),
    nested,
    worktree,
    path.join(fixture, 'missing'),
  ])
  assert.deepEqual(
    new Set(repos.map((repo) => repo.path)),
    new Set([root, nested, worktree]),
  )
  assert.notEqual(
    repos.find((repo) => repo.path === root).id,
    repos.find((repo) => repo.path === worktree).id,
  )
  assert.equal((await request('status', worktree)).branch, 'other')
})

test('read-only service preserves HEAD/index, separates staging, paginates and handles empty, binary, oversized, renamed and deleted files', async () => {
  const root = await makeRepo('status')
  assert.equal((await request('status', root)).branch, 'main')
  assert.deepEqual((await request('log', root)).commits, [])
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n')
  command(root, 'add', '.')
  command(root, 'commit', '-m', 'initial')
  const first = command(root, 'rev-parse', 'HEAD')
  const initial = await request('commit', root, { sha: first })
  assert.equal(initial.files[0].status, 'added')
  assert.match(
    (
      await request('diff', root, {
        scope: 'commit',
        sha: first,
        file: 'file.txt',
      })
    ).patch,
    /\+initial/,
  )
  await fs.writeFile(path.join(root, 'file.txt'), 'staged\n')
  command(root, 'add', 'file.txt')
  await fs.writeFile(path.join(root, 'file.txt'), 'unstaged\n')
  const headBefore = command(root, 'rev-parse', 'HEAD'),
    indexBefore = await fs.readFile(path.join(root, '.git/index'))
  const status = await request('status', root)
  assert.deepEqual(
    status.files.map((file) => file.scope),
    ['staged', 'unstaged'],
  )
  assert.match(
    (await request('diff', root, { scope: 'staged', file: 'file.txt' })).patch,
    /\+staged/,
  )
  assert.match(
    (await request('diff', root, { scope: 'unstaged', file: 'file.txt' }))
      .patch,
    /\+unstaged/,
  )
  assert.equal(command(root, 'rev-parse', 'HEAD'), headBefore)
  assert.deepEqual(
    await fs.readFile(path.join(root, '.git/index')),
    indexBefore,
  )
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  assert.equal(
    (await request('diff', root, { scope: 'untracked', file: 'binary.bin' }))
      .binary,
    true,
  )
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
  assert.equal(
    (await request('diff', root, { scope: 'untracked', file: 'large.txt' }))
      .oversized,
    true,
  )
  command(root, 'add', 'file.txt')
  command(root, 'commit', '-m', 'second')
  assert.equal((await request('log', root, { limit: 1 })).hasMore, true)
  assert.equal(
    (await request('log', root, { offset: 1, limit: 1 })).commits[0].sha,
    first,
  )
  await fs.rename(path.join(root, 'file.txt'), path.join(root, 'renamed.txt'))
  command(root, 'add', '-A')
  assert.equal(
    (await request('status', root)).files.find(
      (file) => file.path === 'renamed.txt',
    ).status,
    'renamed',
  )
  command(root, 'commit', '-m', 'rename')
  await fs.unlink(path.join(root, 'renamed.txt'))
  assert.equal(
    (await request('status', root)).files.find(
      (file) => file.path === 'renamed.txt',
    ).status,
    'deleted',
  )
  command(root, 'checkout', '--detach', first)
  const detached = await request('status', root)
  assert.equal(detached.detached, true)
  assert.equal(detached.branch, null)
  await assert.rejects(request('status', path.join(fixture, 'missing')))
  await assert.rejects(
    request('diff', root, { scope: 'commit', sha: '--bad', file: '../escape' }),
  )
  await assert.rejects(
    gitOperation('status', { filesystemId: 'sftp', path: root }),
    { code: 'EFILESYSTEM_ID' },
  )
})

test('real Node watchers update nested writes, create/delete, stage, commit, branch, worktree refs; prune ignored/symlink trees and release final subscription', async () => {
  const root = await makeRepo('live')
  await fs.mkdir(path.join(root, 'nested'))
  await fs.writeFile(path.join(root, 'nested/file.txt'), 'start\n')
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')
  await fs.mkdir(path.join(root, 'ignored'))
  await fs.mkdir(path.join(root, 'ignored/deep'))
  command(root, 'add', '.')
  command(root, 'commit', '-m', 'initial')
  await fs.symlink(fixture, path.join(root, 'outside'))
  const dirs = await repositoryDirectories({ path: root })
  assert.ok(!dirs.directories.includes(path.join(root, 'ignored')))
  assert.ok(!dirs.directories.includes(path.join(root, 'outside')))
  const registry = createGitWatchRegistry({ delay: 50 })
  let eventCount = 0
  const first = { emit: () => eventCount++ },
    second = { emit: () => {} }
  const watched = await registry.subscribe(first, root)
  assert.equal(watched.watching, true, JSON.stringify(watched.error))
  const watcherCount = registry.watcherCount()
  await registry.subscribe(second, root)
  assert.equal(registry.size(), 1)
  assert.equal(registry.watcherCount(), watcherCount)
  const external = async (action) => {
    const before = eventCount
    await action()
    await waitFor(() => eventCount > before)
  }
  await external(() =>
    fs.writeFile(path.join(root, 'nested/file.txt'), 'external\n'),
  )
  assert.match(
    (
      await request('diff', root, {
        scope: 'unstaged',
        file: 'nested/file.txt',
      })
    ).patch,
    /\+external/,
  )
  await external(() => fs.writeFile(path.join(root, 'new.txt'), 'new\n'))
  assert.ok(
    (await request('status', root)).files.some(
      (file) => file.path === 'new.txt',
    ),
  )
  await external(() => fs.unlink(path.join(root, 'new.txt')))
  assert.ok(
    !(await request('status', root)).files.some(
      (file) => file.path === 'new.txt',
    ),
  )
  await external(() => command(root, 'add', 'nested/file.txt'))
  assert.equal((await request('status', root)).files[0].scope, 'staged')
  await external(() => command(root, 'commit', '-m', 'external commit'))
  assert.equal(
    (await request('log', root)).commits[0].subject,
    'external commit',
  )
  await external(() => command(root, 'checkout', '-b', 'changed'))
  assert.equal((await request('status', root)).branch, 'changed')
  registry.unsubscribe(first, root)
  assert.equal(registry.size(), 1)
  registry.unsubscribe(second, root)
  assert.equal(registry.size(), 0)
  assert.equal(registry.watcherCount(), 0)
})

test('frontend refresh invalidates stale responses, preserves history selection, mode and collapsed sections; dispose drops events', async () => {
  let event,
    stopped = 0,
    release,
    sequence = 0
  const file = {
    path: 'a.txt',
    scope: 'unstaged',
    status: 'modified',
    additions: 1,
    deletions: 1,
  }
  const api = {
    status: async () => {
      const version = ++sequence
      if (version === 1)
        await new Promise((resolve) => {
          release = resolve
        })
      return {
        ok: true,
        branch: `branch${version}`,
        files: [file],
        head: `${version}`,
      }
    },
    log: async () => ({ ok: true, commits: [{ sha: 'old' }], hasMore: false }),
    commit: async () => ({
      ok: true,
      commit: { sha: 'old' },
      files: [{ ...file, scope: 'commit' }],
    }),
    diff: async (_root, selection) => ({
      ok: true,
      patch: `${selection.sha || sequence}`,
      binary: false,
      oversized: false,
    }),
  }
  const viewer = createGitViewer(
    { id: '/repo', path: '/repo' },
    {
      api,
      registry: {
        subscribe: (_repo, callback) => {
          event = callback
          return () => stopped++
        },
      },
    },
  )
  event({})
  event({})
  release()
  await waitFor(() => !viewer.state.updating)
  assert.equal(viewer.state.branch, 'branch2')
  viewer.state.mode = 'unified'
  await viewer.selectCommit('old')
  const record = viewer.diffs.records.get('commit\0a.txt')
  viewer.diffs.setNear(record.key, true)
  await waitFor(() => record.result?.patch === 'old')
  viewer.diffs.toggle(record.key)
  event({})
  await waitFor(() => !viewer.state.updating)
  assert.equal(viewer.state.view, 'history')
  assert.equal(viewer.state.selectedCommit, 'old')
  assert.equal(record.result.patch, 'old')
  assert.equal(viewer.state.mode, 'unified')
  assert.equal(record.expanded, false)
  viewer.dispose()
  event({})
  assert.equal(stopped, 1)
})

test('frontend registry serializes final unwatch with pending watch and reuses subscriptions', async () => {
  const calls = [],
    listeners = new Map()
  let release
  const transport = {
    request: async (name) => {
      calls.push(name)
      if (name === 'git:watch')
        await new Promise((resolve) => {
          release = resolve
        })
      return { ok: true }
    },
    subscribe: (name, callback) => {
      listeners.set(name, callback)
      return () => listeners.delete(name)
    },
  }
  const registry = frontendRegistry(transport, {
    delay: 1,
    targetWindow: null,
    targetDocument: null,
  })
  const repository = { id: '/one', path: '/one' },
    one = registry.subscribe(repository, () => {}),
    two = registry.subscribe(repository, () => {})
  await waitFor(() => release)
  one()
  assert.equal(registry.count(), 1)
  two()
  release()
  await waitFor(() => calls.includes('git:unwatch'))
  assert.deepEqual(calls, ['git:watch', 'git:unwatch'])
  assert.equal(registry.count(), 0)
  assert.equal(listeners.size, 0)
})

test('discovery stays local, batched and outside mounted virtual rows', async () => {
  let calls = 0
  const api = {
    detect: async (paths) => {
      calls++
      assert.ok(paths.length <= 256)
      return {
        ok: true,
        repositories: [{ requestedPath: paths[0], id: paths[0] }],
      }
    },
  }
  const response = {
    ok: true,
    entries: Array.from({ length: 300 }, (_, i) => ({
      path: `/root/d${i}`,
      isDirectory: true,
    })),
  }
  await discoverListedRepositories(
    { providerId: 'sftp', path: '/root', response },
    api,
  )
  assert.equal(calls, 0)
  const result = await discoverListedRepositories(
    { providerId: 'local', path: '/root', response },
    api,
  )
  assert.equal(calls, 2)
  assert.equal(result.repository.id, '/root')
  const node = await fs.readFile(
    new URL('../src/components/FileTreeNode.vue', import.meta.url),
    'utf8',
  )
  assert.ok(!node.includes('git.detect'))
  assert.match(node, /@click\.stop=.*open-git/)
})

test('real workspace opens Git with no document, deduplicates canonical worktree identity, keeps two repos independent, excludes saves and releases on close', async () => {
  const vm = await import('node:vm'),
    vue = await import('vue')
  const { getDocumentHandler } =
    await import('../src/editor/documentHandlers.js')
  const source = (
    await fs.readFile(
      new URL('../src/composables/useEditorWorkspace.js', import.meta.url),
      'utf8',
    )
  )
    .replace(/^import .*$/gm, '')
    .replace('export const useEditorWorkspace', 'const useEditorWorkspace')
  const created = [],
    disposed = []
  const dependencies = {
    computed: vue.computed,
    reactive: vue.reactive,
    markRaw: vue.markRaw,
    ref: vue.ref,
    watch: vue.watch,
    entryChange: vue.ref(null),
    relocatePath: (path) => path,
    useTextFiles: () => ({}),
    getDocumentHandler,
    createGitViewer: (repository) => {
      created.push(repository.id)
      return {
        state: vue.reactive({}),
        dispose: () => disposed.push(repository.id),
      }
    },
  }
  const factory = vm.compileFunction(
    `${source}\nreturn useEditorWorkspace`,
    Object.keys(dependencies),
  )(...Object.values(dependencies))
  const workspace = factory(),
    context = {
      filesystemId: 'local',
      sourcePane: 'left',
      sourceRootPath: '/browse',
      repository: { id: '/repo', path: '/repo', name: 'repo' },
    }
  assert.equal(workspace.tabs.value.length, 0)
  const one = workspace.openGit(context)
  assert.equal(one.type, 'git')
  assert.equal(workspace.activeTab.value.id, one.id)
  assert.equal(one.dirty, undefined)
  const two = workspace.openGit({
    ...context,
    repository: {
      id: '/other-worktree',
      path: '/other-worktree',
      name: 'other',
    },
  })
  assert.equal(workspace.tabs.value.length, 2)
  assert.equal(workspace.activeTab.value.id, two.id)
  assert.equal(
    workspace.openGit({ ...context, sourcePane: 'right' }).id,
    one.id,
  )
  assert.equal(workspace.tabs.value.length, 2)
  assert.equal(workspace.activeTab.value.id, one.id)
  assert.equal((await workspace.saveTab(one.id)).ok, false)
  workspace.updateContent(one.id, 'must not become a document')
  assert.equal(one.content, undefined)
  workspace.closeTab(one.id)
  assert.deepEqual(disposed, ['/repo'])
  assert.equal(workspace.activeTab.value.id, two.id)
  workspace.closeTab(two.id)
  assert.equal(workspace.tabs.value.length, 0)
  assert.equal(workspace.activeTab.value, null)
  assert.deepEqual(created, ['/repo', '/other-worktree'])
  assert.deepEqual(disposed, created)
})

test('empty repositories create watchers before the first commit and missing metadata folders do not disable live updates', async () => {
  const root = await makeRepo('empty-watch'),
    registry = createGitWatchRegistry({ delay: 25 })
  let events = 0
  const socket = { emit: () => events++ }
  try {
    const watched = await registry.subscribe(socket, root)
    assert.equal(watched.watching, true, JSON.stringify(watched.error))
    assert.equal(watched.error, null)
    await fs.writeFile(path.join(root, 'first.txt'), 'first\n')
    await waitFor(() => events > 0)
    assert.equal((await request('status', root)).files[0].status, 'untracked')
  } finally {
    registry.unsubscribe(socket, root)
  }
  assert.equal(registry.size(), 0)
})

test('Git actions occupy the existing right status cell and use a shared 20px square control', async () => {
  const source = await fs.readFile(
    new URL('../src/components/FileTreeNode.vue', import.meta.url),
    'utf8',
  )
  const cell = source.slice(
    source.indexOf('<span class="tree-status-cell">'),
    source.indexOf('<span v-if="!compact" class="tree-size"'),
  )
  assert.match(cell, /git-repository-button/)
  assert.match(cell, /v-else-if="statusBadge"/)
  const name = source.slice(
    source.indexOf('<span v-else class="tree-label"'),
    source.indexOf('<span class="tree-status-cell">'),
  )
  assert.ok(!name.includes('git-repository-button'))
  const styles = await fs.readFile(
    new URL('../src/styles/main/_panels.scss', import.meta.url),
    'utf8',
  )
  assert.match(
    styles,
    /&\.git-repository-button\s*\{\s*width: 20px;\s*height: 20px;/,
  )
})

test('linked worktree watches resolved administration and common refs outside its root', async () => {
  const root = await makeRepo('worktree-live')
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n')
  command(root, 'add', '.')
  command(root, 'commit', '-m', 'initial')
  const linked = path.join(fixture, 'linked-live')
  command(root, 'worktree', 'add', '-b', 'linked', linked)
  const registry = createGitWatchRegistry({ delay: 40 }),
    events = []
  const socket = { emit: (_name, event) => events.push(event) }
  try {
    const watched = await registry.subscribe(socket, linked)
    assert.equal(watched.watching, true, JSON.stringify(watched.error))
    assert.ok(!watched.repository.commonDir.startsWith(`${linked}/`))
    await fs.writeFile(path.join(linked, 'file.txt'), 'linked edit\n')
    await waitFor(() => events.length > 0)
    events.length = 0
    command(linked, 'add', 'file.txt')
    await waitFor(() => events.length > 0)
    assert.equal((await request('status', linked)).files[0].scope, 'staged')
    events.length = 0
    command(linked, 'commit', '-m', 'worktree external commit')
    await waitFor(() => events.length > 0)
    assert.equal(
      (await request('log', linked)).commits[0].subject,
      'worktree external commit',
    )
    events.length = 0
    command(root, 'branch', 'common-ref')
    await waitFor(() => events.length > 0)
    assert.ok(
      (await request('branches', linked)).branches.includes('common-ref'),
    )
  } finally {
    registry.unsubscribe(socket, linked)
  }
  assert.equal(registry.watcherCount(), 0)
})
