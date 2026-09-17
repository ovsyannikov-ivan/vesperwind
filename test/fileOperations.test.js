import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-operations-'))
process.env.FILE_MANAGER_ROOT = fixtureRoot

const { performFileOperation } = await import('../server/fileOperations.js')

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

const createFolder = (name) => fs.mkdir(path.join(fixtureRoot, name))

test('creates empty files and folders without overwriting existing entries', async () => {
  const file = await performFileOperation({ action: 'create-file', targetDirectory: fixtureRoot, name: 'new file.txt' })
  assert.equal(await fs.readFile(file.destinationPath, 'utf8'), '')
  await fs.writeFile(file.destinationPath, 'keep me')
  await assert.rejects(() => performFileOperation({ action: 'create-file', targetDirectory: fixtureRoot, name: 'new file.txt' }), { code: 'EEXIST' })
  assert.equal(await fs.readFile(file.destinationPath, 'utf8'), 'keep me')
  const folder = await performFileOperation({ action: 'create-folder', targetDirectory: fixtureRoot, name: 'new folder' })
  assert.equal((await fs.stat(folder.destinationPath)).isDirectory(), true)
  await assert.rejects(() => performFileOperation({ action: 'create-folder', targetDirectory: fixtureRoot, name: 'new folder' }), { code: 'EEXIST' })
})

test('renames files and nonempty folders, rejecting collisions and root renames', async () => {
  const source = path.join(fixtureRoot, 'rename-source')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'before.txt'), 'preserved')
  const folder = await performFileOperation({ action: 'rename', sourcePath: source, name: 'rename-destination' })
  const file = await performFileOperation({ action: 'rename', sourcePath: path.join(folder.destinationPath, 'before.txt'), name: 'after.txt' })
  assert.equal(await fs.readFile(file.destinationPath, 'utf8'), 'preserved')
  await fs.writeFile(path.join(folder.destinationPath, 'exists.txt'), 'existing')
  await assert.rejects(() => performFileOperation({ action: 'rename', sourcePath: file.destinationPath, name: 'exists.txt' }), { code: 'EEXIST' })
  assert.equal(await fs.readFile(file.destinationPath, 'utf8'), 'preserved')
  await assert.rejects(() => performFileOperation({ action: 'rename', sourcePath: fixtureRoot, name: 'root2' }), { code: 'EROOT_OPERATION' })
})

test('rejects traversal names, unavailable providers and creation through outside symlinks', async () => {
  for (const name of ['', ' ', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'nul\0name']) {
    await assert.rejects(() => performFileOperation({ action: 'create-file', targetDirectory: fixtureRoot, name }), { code: 'EINVALID_NAME' })
  }
  await assert.rejects(() => performFileOperation({ action: 'create-file', targetDirectory: path.dirname(fixtureRoot), name: 'escape' }), { code: 'EOUTSIDE_ROOT' })
  await assert.rejects(() => performFileOperation({ action: 'create-file', targetDirectory: fixtureRoot, name: 'remote', targetFilesystemId: 'ssh:test' }), { code: 'EFILESYSTEM_ID' })
  const link = path.join(fixtureRoot, 'outside-link')
  await fs.symlink(path.dirname(fixtureRoot), link)
  await assert.rejects(() => performFileOperation({ action: 'create-file', targetDirectory: link, name: 'escape' }), { code: 'EOUTSIDE_ROOT' })
})

test('copies files and folders into the selected target folder', async () => {
  const target = path.join(fixtureRoot, 'copy-target')
  const sourceFile = path.join(fixtureRoot, 'copy-me.txt')
  const sourceFolder = path.join(fixtureRoot, 'copy-folder')
  await Promise.all([
    createFolder('copy-target'),
    fs.writeFile(sourceFile, 'file contents'),
    fs.mkdir(sourceFolder),
  ])
  await fs.writeFile(path.join(sourceFolder, 'nested.txt'), 'nested contents')

  await performFileOperation({
    action: 'copy',
    sourcePath: sourceFile,
    targetDirectory: target,
  })
  await performFileOperation({
    action: 'copy',
    sourcePath: sourceFolder,
    targetDirectory: target,
  })

  assert.equal(
    await fs.readFile(path.join(target, 'copy-me.txt'), 'utf8'),
    'file contents',
  )
  assert.equal(
    await fs.readFile(path.join(target, 'copy-folder', 'nested.txt'), 'utf8'),
    'nested contents',
  )
})

test('moves a file into the selected target folder', async () => {
  const target = path.join(fixtureRoot, 'move-target')
  const source = path.join(fixtureRoot, 'move-me.txt')
  await Promise.all([createFolder('move-target'), fs.writeFile(source, 'moving')])

  const result = await performFileOperation({
    action: 'move',
    sourcePath: source,
    targetDirectory: target,
  })

  assert.equal(result.destinationPath, path.join(target, 'move-me.txt'))
  await assert.rejects(() => fs.lstat(source), { code: 'ENOENT' })
  assert.equal(await fs.readFile(result.destinationPath, 'utf8'), 'moving')
})

test('creates a relative symbolic link in the selected target folder', async () => {
  const target = path.join(fixtureRoot, 'link-target')
  const source = path.join(fixtureRoot, 'link-me.txt')
  await Promise.all([createFolder('link-target'), fs.writeFile(source, 'linked')])

  const result = await performFileOperation({
    action: 'link',
    sourcePath: source,
    targetDirectory: target,
  })

  assert.equal(await fs.readlink(result.destinationPath), '../link-me.txt')
  assert.equal(await fs.readFile(result.destinationPath, 'utf8'), 'linked')
})

test('deletes files and non-empty folders recursively', async () => {
  const sourceFile = path.join(fixtureRoot, 'delete-me.txt')
  const sourceFolder = path.join(fixtureRoot, 'delete-folder')
  await fs.writeFile(sourceFile, 'temporary')
  await fs.mkdir(sourceFolder)
  await fs.writeFile(path.join(sourceFolder, 'nested.txt'), 'nested')

  const fileResult = await performFileOperation({
    action: 'delete',
    sourcePath: sourceFile,
  })
  const folderResult = await performFileOperation({
    action: 'delete',
    sourcePath: sourceFolder,
  })

  assert.equal(fileResult.destinationPath, null)
  assert.equal(folderResult.destinationPath, null)
  await assert.rejects(() => fs.lstat(sourceFile), { code: 'ENOENT' })
  await assert.rejects(() => fs.lstat(sourceFolder), { code: 'ENOENT' })
})

test('rejects collisions, cycles, and paths outside the configured root', async () => {
  const sourceFolder = path.join(fixtureRoot, 'cycle-source')
  const nestedTarget = path.join(sourceFolder, 'nested')
  const collisionTarget = path.join(fixtureRoot, 'collision-target')
  const collisionSource = path.join(fixtureRoot, 'duplicate.txt')
  await fs.mkdir(nestedTarget, { recursive: true })
  await createFolder('collision-target')
  await Promise.all([
    fs.writeFile(collisionSource, 'source'),
    fs.writeFile(path.join(collisionTarget, 'duplicate.txt'), 'existing'),
  ])

  await assert.rejects(
    () =>
      performFileOperation({
        action: 'copy',
        sourcePath: sourceFolder,
        targetDirectory: nestedTarget,
      }),
    { code: 'ECYCLE' },
  )
  await assert.rejects(
    () =>
      performFileOperation({
        action: 'copy',
        sourcePath: collisionSource,
        targetDirectory: collisionTarget,
      }),
    { code: 'EEXIST' },
  )
  await assert.rejects(
    () =>
      performFileOperation({
        action: 'copy',
        sourcePath: collisionSource,
        targetDirectory: path.dirname(fixtureRoot),
      }),
    { code: 'EOUTSIDE_ROOT' },
  )
  await assert.rejects(
    () =>
      performFileOperation({
        action: 'delete',
        sourcePath: fixtureRoot,
      }),
    { code: 'EROOT_OPERATION' },
  )
})
