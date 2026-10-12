// Read-only CLI adapter for browser/SEA. Never invokes a shell or a write command.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ignore from 'ignore'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'

export const MAX_DIFF_BYTES = 1024 * 1024
const fail = (code, message) => Object.assign(new Error(message), { code })
const execute = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 12000, maxBuffer: 8 * MAX_DIFF_BYTES, ...options },
      (error, stdout) => {
        if (error)
          reject(
            error.code === 'ENOENT'
              ? fail(
                  'EGIT_DEPENDENCY',
                  'Git executable is required for the Node backend',
                )
              : error,
          )
        else resolve(stdout)
      },
    )
  })
const gitEnvironment = () => {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  }
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key]
  return env
}
export const runGit = (root, args, options) =>
  execute(
    'git',
    [
      '--no-optional-locks',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'diff.external=',
      '-c',
      'protocol.allow=never',
      '-C',
      root,
      ...args,
    ],
    {
      env: gitEnvironment(),
      ...options,
    },
  )

// Passive OS metadata, including the attributes Node's Stats does not expose.
// Never open a cloud placeholder, including .git pointer/config files.
export const assertLocal = async (paths) => {
  if (!paths.length) return
  if (process.platform === 'darwin') {
    for (let i = 0; i < paths.length; i += 128) {
      const values = await execute('/usr/bin/stat', [
        '-f',
        '%f',
        ...paths.slice(i, i + 128),
      ])
      if (
        values
          .trim()
          .split('\n')
          .some((value) => (Number(value) & 0x40000000) !== 0)
      )
        throw fail(
          'ECONTENT_UNAVAILABLE',
          'Git inspection requires locally available files; cloud placeholders are not downloaded',
        )
    }
  } else if (process.platform === 'win32') {
    for (let offset = 0; offset < paths.length; offset += 32) {
      // LiteralPath receives JSON as base64, never interpolated shell text.
      const encoded = Buffer.from(
        JSON.stringify(paths.slice(offset, offset + 32)),
        'utf8',
      ).toString('base64')
      const script = `$p=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); foreach($f in $p){$a=[int](Get-Item -Force -LiteralPath $f -ErrorAction Stop).Attributes; if(($a -band 0x441000) -ne 0){exit 23}}`
      try {
        await execute('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          script,
        ])
      } catch {
        throw fail(
          'ECONTENT_UNAVAILABLE',
          'Unable to verify local Git content availability',
        )
      }
    }
  }
}
const existingLocal = async (paths) => {
  const present = []
  for (const file of paths) {
    try {
      const meta = await fs.lstat(file)
      if (!meta.isSymbolicLink()) present.push(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await assertLocal(present)
}
export const openRepository = async (requested) => {
  const root = await verifyRealPathInsideRoot(resolveInsideRoot(requested))
  await existingLocal([root, path.join(root, '.git')])
  const marker = await fs.lstat(path.join(root, '.git'))
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile()))
    throw fail('EGIT_REPOSITORY', 'Not a working-tree repository root')
  let gitDir = path.join(root, '.git')
  if (marker.isFile()) {
    if (marker.size > 8192)
      throw fail('EGIT_REPOSITORY', 'Invalid .git pointer')
    const pointer = (await fs.readFile(gitDir, 'utf8')).trim()
    if (!pointer.startsWith('gitdir: '))
      throw fail('EGIT_REPOSITORY', 'Invalid .git pointer')
    gitDir = path.resolve(root, pointer.slice(8))
  }
  await existingLocal([
    gitDir,
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'config'),
    path.join(gitDir, 'commondir'),
  ])
  let commonDir = gitDir
  try {
    commonDir = path.resolve(
      gitDir,
      (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim(),
    )
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  await existingLocal([
    commonDir,
    ...['config', 'packed-refs', 'index', 'info/exclude', 'shallow'].map(
      (name) => path.join(commonDir, name),
    ),
  ])
  for (const admin of [
    gitDir,
    commonDir,
    ...['HEAD', 'config', 'index', 'packed-refs', 'commondir'].map((name) =>
      path.join(gitDir, name),
    ),
    ...['config', 'packed-refs', 'info/exclude'].map((name) =>
      path.join(commonDir, name),
    ),
  ]) {
    try {
      if ((await fs.lstat(admin)).isSymbolicLink())
        throw fail(
          'EGIT_REPOSITORY',
          'Symbolic Git administration paths are not supported',
        )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const headText = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
  if (headText.startsWith('ref: ')) {
    const ref = headText.slice(5)
    validateFile(ref)
    await existingLocal([path.join(gitDir, ref), path.join(commonDir, ref)])
  }
  const top = (await runGit(root, ['rev-parse', '--show-toplevel'])).trim()
  if ((await fs.realpath(top)) !== root)
    throw fail('EGIT_REPOSITORY', 'Not a working-tree repository root')
  return { id: root, path: root, name: path.basename(root), gitDir, commonDir }
}
export const detectRepositories = async (paths) => {
  if (!Array.isArray(paths) || paths.length > 256)
    throw fail('EINVAL', 'Git detection accepts at most 256 directories')
  const repositories = []
  // Bound process concurrency during batched directory discovery.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) {
        const requested = paths[next++]
        try {
          const repo = await openRepository(requested)
          repositories.push({ ...repo, requestedPath: requested })
        } catch {}
      }
    }),
  )
  return repositories
}
export const parseNumstat = (output, scope) => {
  const fields = output.split('\0'),
    files = []
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i])
    if (!match) continue
    let oldPath = null,
      filePath = match[3]
    if (!filePath) {
      oldPath = fields[++i]
      filePath = fields[++i]
    }
    files.push({
      path: filePath,
      oldPath,
      scope,
      status: oldPath ? 'renamed' : 'modified',
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-',
    })
  }
  return files
}
const diffArgs = (scope, sha) =>
  scope === 'commit'
    ? ['diff-tree', '--root', '--no-commit-id', '-r', '-M', sha]
    : ['diff', ...(scope === 'staged' ? ['--cached'] : []), '-M']
const validateSha = (sha) => {
  if (!/^[a-f\d]{40,64}$/i.test(sha || ''))
    throw fail('EINVAL', 'A full commit SHA is required')
  return sha
}
const validateFile = (file) => {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
    throw fail('EINVAL', 'Invalid repository-relative file path')
  return file
}
const listDiff = async (repo, scope, sha) => {
  const args = diffArgs(scope, sha)
  const files = parseNumstat(
    await runGit(repo.path, [
      ...args,
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
    ]),
    scope,
  )
  const names = (
    await runGit(repo.path, [
      ...args,
      '--name-status',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
    ])
  ).split('\0')
  const statuses = new Map()
  for (let i = 0; i < names.length - 1;) {
    const status = names[i++]
    let file = names[i++]
    if (/^[RC]/.test(status)) file = names[i++]
    statuses.set(
      file,
      {
        A: 'added',
        D: 'deleted',
        M: 'modified',
        R: 'renamed',
        T: 'modified',
        U: 'conflicted',
      }[status[0]] || 'modified',
    )
  }
  return files.map((file) => ({
    ...file,
    status: statuses.get(file.path) || file.status,
  }))
}
// A bounded directory walk used for watcher topology and placeholder preflight.
// Only metadata is inspected, symlinks/ignored/nested repository trees are pruned.
export const repositoryDirectories = async (
  repo,
  limit = 2048,
  checkFiles = true,
) => {
  const directories = [],
    queue = [{ dir: repo.path, rules: [] }],
    localFiles = []
  const tracked = new Set(
    (await runGit(repo.path, ['ls-files', '--cached', '-z']))
      .split('\0')
      .filter(Boolean),
  )
  const trackedDirs = new Set()
  for (const file of tracked) {
    let dir = path.posix.dirname(file)
    while (dir !== '.') {
      trackedDirs.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  const rootRules = ignore()
  const readRules = async (file) => {
    try {
      await existingLocal([file])
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }
  if (repo.commonDir)
    rootRules.add(await readRules(path.join(repo.commonDir, 'info/exclude')))
  const globalFile = (
    await runGit(repo.path, [
      'config',
      '--path',
      '--get',
      'core.excludesFile',
    ]).catch(() => '')
  ).trim()
  if (globalFile)
    rootRules.add(
      await readRules(
        globalFile.startsWith('~/')
          ? path.join(os.homedir(), globalFile.slice(2))
          : path.resolve(repo.path, globalFile),
      ),
    )
  while (queue.length && directories.length < limit) {
    const { dir, rules } = queue.shift()
    await assertLocal([dir])
    directories.push(dir)
    const base = path.relative(repo.path, dir).split(path.sep).join('/')
    const content = await readRules(path.join(dir, '.gitignore'))
    const inherited = [
      ...rules,
      ...(content ? [{ base, matcher: ignore().add(content) }] : []),
    ]
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name),
        relative = path.relative(repo.path, full).split(path.sep).join('/')
      let ignored = rootRules.test(
        relative + (entry.isDirectory() ? '/' : ''),
      ).ignored
      for (const rule of inherited) {
        const child = rule.base
          ? relative.slice(rule.base.length + 1)
          : relative
        const result = rule.matcher.test(
          child + (entry.isDirectory() ? '/' : ''),
        )
        if (result.ignored) ignored = true
        else if (result.unignored) ignored = false
      }
      if (ignored && !tracked.has(relative) && !trackedDirs.has(relative))
        continue
      if (entry.isDirectory()) {
        try {
          await fs.lstat(path.join(full, '.git'))
          continue
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        queue.push({ dir: full, rules: inherited })
      } else if (checkFiles && entry.isFile()) localFiles.push(full)
      if (localFiles.length > 100000)
        throw fail('EGIT_LIMIT', 'Repository content preflight limit reached')
    }
  }
  if (checkFiles) await existingLocal(localFiles)
  return { directories, limited: queue.length > 0 }
}
const preflight = async (repo) => {
  const result = await repositoryDirectories(repo)
  if (result.limited)
    throw fail(
      'EGIT_LIMIT',
      'Repository exceeds the safe inspection directory budget',
    )
}
const commitFormat = '%H%x00%s%x00%an%x00%ae%x00%at%x00%P%x00%B%x00'
const parseCommits = (output) => {
  const fields = output.split('\0'),
    commits = []
  for (let i = 0; i + 6 < fields.length; i += 7) {
    const sha = fields[i].trim()
    if (!sha) continue
    commits.push({
      sha,
      subject: fields[i + 1],
      author: fields[i + 2],
      email: fields[i + 3],
      timestamp: Number(fields[i + 4]),
      parents: fields[i + 5].split(' ').filter(Boolean),
      message: fields[i + 6].trimEnd(),
    })
  }
  return commits
}
const preflightObjects = async (repo) => {
  try {
    await fs.lstat(path.join(repo.commonDir, 'objects/info/alternates'))
    throw fail(
      'EGIT_ALTERNATES',
      'Git object alternates are not supported by safe local inspection',
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const queue = [
    path.join(repo.commonDir, 'objects'),
    path.join(repo.commonDir, 'refs'),
    path.join(repo.gitDir, 'refs'),
  ]
  let count = 0
  while (queue.length) {
    const dir = queue.shift()
    try {
      await fs.lstat(dir)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    await assertLocal([dir])
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const paths = []
    for (const entry of entries) {
      if (++count > 100000)
        throw fail('EGIT_LIMIT', 'Git object metadata budget reached')
      if (entry.isSymbolicLink())
        throw fail(
          'EGIT_REPOSITORY',
          'Symbolic Git administration paths are not supported',
        )
      const full = path.join(dir, entry.name)
      paths.push(full)
      if (entry.isDirectory()) queue.push(full)
    }
    await assertLocal(paths)
  }
}
export const gitOperation = async (operation, payload) => {
  if (payload?.filesystemId !== 'local')
    throw fail('EFILESYSTEM_ID', 'Git is available only for local filesystems')
  if (operation === 'detect')
    return { repositories: await detectRepositories(payload.paths) }
  const repo = await openRepository(payload.path)
  await preflightObjects(repo)
  if (operation === 'status') {
    await preflight(repo)
    const branch =
      (
        await runGit(repo.path, [
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ]).catch(() => '')
      ).trim() || null
    const head =
      (
        await runGit(repo.path, ['rev-parse', '--verify', 'HEAD']).catch(
          () => '',
        )
      ).trim() || null
    const staged = await listDiff(repo, 'staged'),
      unstaged = await listDiff(repo, 'unstaged')
    const untracked = []
    for (const file of (
      await runGit(repo.path, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ])
    )
      .split('\0')
      .filter(Boolean)) {
      const full = path.join(repo.path, file),
        meta = await fs.lstat(full)
      let additions = 0,
        binary = false
      const oversized = meta.size > MAX_DIFF_BYTES || meta.isDirectory()
      if (meta.isFile() && !oversized) {
        await existingLocal([full])
        const bytes = await fs.readFile(full)
        binary = bytes.includes(0)
        if (!binary && bytes.length)
          additions =
            bytes.toString('utf8').split('\n').length -
            (bytes.at(-1) === 10 ? 1 : 0)
      }
      untracked.push({
        path: file,
        oldPath: null,
        scope: 'untracked',
        status: 'untracked',
        additions,
        deletions: 0,
        binary,
        oversized,
      })
    }
    return {
      repository: repo,
      branch,
      head,
      detached: !branch && !!head,
      files: [...staged, ...unstaged, ...untracked],
    }
  }
  if (operation === 'branches')
    return {
      branches: (
        await runGit(repo.path, [
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean),
    }
  if (operation === 'log') {
    const offset = Math.max(0, Number(payload.offset) || 0),
      limit = Math.min(100, Math.max(1, Number(payload.limit) || 50))
    const head = await runGit(repo.path, [
      'rev-parse',
      '--verify',
      'HEAD',
    ]).catch(() => '')
    if (!head) return { commits: [], hasMore: false }
    const commits = parseCommits(
      await runGit(repo.path, [
        'log',
        `--skip=${offset}`,
        `-n${limit + 1}`,
        `--format=${commitFormat}`,
      ]),
    )
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
  }
  if (operation === 'commit') {
    const sha = validateSha(payload.sha)
    const commits = parseCommits(
      await runGit(repo.path, ['show', '-s', `--format=${commitFormat}`, sha]),
    )
    // Explicit first-parent comparison, even for merge commits.
    const commit = commits[0]
    const files = commit.parents.length
      ? await listDiffAgainstParent(repo, commit)
      : await listDiff(repo, 'commit', sha)
    return { commit, files }
  }
  if (operation === 'diff') {
    const file = validateFile(payload.file),
      scope = payload.scope
    if (!['commit', 'staged', 'unstaged', 'untracked'].includes(scope))
      throw fail('EINVAL', 'Invalid diff scope')
    if (scope !== 'commit') await preflight(repo)
    try {
      if (scope === 'untracked') {
        const requested = path.join(repo.path, file),
          link = await fs.lstat(requested)
        if (link.isSymbolicLink())
          return {
            binary: false,
            oversized: false,
            patch: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${await fs.readlink(requested)}\n`,
          }
        const full = await verifyRealPathInsideRoot(requested)
        await existingLocal([full])
        const meta = await fs.lstat(full)
        if (!meta.isFile() || meta.size > MAX_DIFF_BYTES)
          return { binary: false, oversized: true, patch: '' }
        const bytes = await fs.readFile(full)
        if (bytes.includes(0))
          return { binary: true, oversized: false, patch: '' }
        const lines = bytes.toString('utf8').split('\n')
        if (lines.at(-1) === '') lines.pop()
        const patch = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
        return { binary: false, oversized: false, patch }
      }
      let args = diffArgs(scope, payload.sha)
      if (scope === 'commit') {
        const sha = validateSha(payload.sha),
          parent = (
            await runGit(repo.path, ['rev-list', '--parents', '-n1', sha])
          )
            .trim()
            .split(' ')[1]
        if (parent) args = ['diff', '-M', parent, sha]
      }
      const patch = await runGit(
        repo.path,
        [
          ...args,
          '--patch',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--',
          file,
          ...(payload.oldPath ? [validateFile(payload.oldPath)] : []),
        ],
        { maxBuffer: MAX_DIFF_BYTES },
      )
      return {
        patch,
        binary: /(^|\n)(Binary files |GIT binary patch)/.test(patch),
        oversized: false,
      }
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        return { patch: '', binary: false, oversized: true }
      throw error
    }
  }
  throw fail('ENOTSUPPORTED', 'Unsupported read-only Git operation')
}
const listDiffAgainstParent = async (repo, commit) => {
  const args = ['diff', '-M', commit.parents[0], commit.sha]
  const files = parseNumstat(
    await runGit(repo.path, [
      ...args,
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
    ]),
    'commit',
  )
  const names = (
      await runGit(repo.path, [...args, '--name-status', '-z'])
    ).split('\0'),
    statuses = new Map()
  for (let i = 0; i < names.length - 1;) {
    const status = names[i++]
    let file = names[i++]
    if (status[0] === 'R') file = names[i++]
    statuses.set(
      file,
      { A: 'added', D: 'deleted', R: 'renamed' }[status[0]] || 'modified',
    )
  }
  return files.map((file) => ({
    ...file,
    status: statuses.get(file.path) || file.status,
  }))
}
