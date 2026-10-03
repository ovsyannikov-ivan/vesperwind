import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-archives-test-'))
process.env.FILE_MANAGER_ROOT = root
const { bundledArchiveWorker, runWorker, performArchive, registerArchiveHandlers } = await import('../server/archives.js')
const { validateArchiveRequest } = await import('../shared/archivePolicy.js')
const binary = bundledArchiveWorker()
let available = true
try { await fs.access(binary) } catch { available = false }
const options = { skip: !available && 'Build the bundled sidecar with npm run build:archives' }
const fixtures = path.resolve('test/fixtures/archives')
const location = (value) => ({ providerId: 'local', path: value })
const request = (action, source, name) => ({ action, sources: [location(source)], target: location(root), name })
test.after(async () => fs.rm(root, { recursive: true, force: true }))
test('archive request policy rejects remote providers and invalid destination names', () => {
  assert.equal(validateArchiveRequest({ ...request('create', '/file', 'a.zip'), target: { providerId: 'sftp:a', path: '/' } }).code, 'ENOTSUPPORTED')
  assert.equal(validateArchiveRequest(request('create', '/file', '../evil.zip')).code, 'EINVAL')
  assert.equal(validateArchiveRequest(request('create', '/file', 'COM¹.zip')).code, 'EINVAL')
})
test('real bundled worker reads ZIP, TAR, TGZ, RAR and stored/compressed RAR5', options, async () => {
  for (const name of ['safe.zip', 'safe.tar', 'safe.tgz', 'root.tar', 'rar_binary_data.rar', 'rar5_stored.rar', 'rar5_compressed.rar']) {
    const source = path.join(root, name); await fs.copyFile(path.join(fixtures, name), source)
    const result = await performArchive(request('extract', source, `extracted-${name}`))
    assert.ok((await fs.readdir(result.destinationPath)).length, name)
    if (name === 'safe.zip') assert.equal(await fs.readFile(path.join(result.destinationPath, 'Книга/read me.txt'), 'utf8'), 'archive fixture\n')
    if (name === 'root.tar' && process.platform !== 'win32') assert.equal((await fs.stat(result.destinationPath)).mode & 0o777, 0o700)
  }
})
test('real ZIP creation round trips directories and filenames containing shell metacharacters', options, async () => {
  const source = path.join(root, 'files $(never-run)'); await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'Книга.txt'), 'book')
  await performArchive(request('create', source, 'created.zip'))
  const result = await performArchive(request('extract', path.join(root, 'created.zip'), 'roundtrip'))
  assert.equal(await fs.readFile(path.join(result.destinationPath, path.basename(source), 'Книга.txt'), 'utf8'), 'book')
})
test('unsafe entries fail with no published folder, no escaped file and no staging leftovers', options, async () => {
  for (const name of ['dotdot.zip', 'absolute.zip', 'drive.zip', 'unc.zip', 'ads.zip', 'reserved.zip', 'device.zip', 'trailing.zip',
    'dotdot.tar', 'absolute.tar', 'drive.tar', 'unc.tar', 'symlink.tar', 'hardlink.tar', 'special.tar', 'duplicate.tar', 'rar.rar']) {
    const source = path.join(root, name); await fs.copyFile(path.join(fixtures, name), source)
    await assert.rejects(performArchive(request('extract', source, `rejected-${name}`)), (error) => error.code.startsWith('EARCHIVE_'), name)
    await assert.rejects(fs.stat(path.join(root, `rejected-${name}`)), { code: 'ENOENT' })
  }
  assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.vesperwind-archive-')))
  await assert.rejects(fs.stat(path.join(root, 'escaped.txt')), { code: 'ENOENT' })
})
test('atomic publication never replaces an existing file, folder or symlink', options, async () => {
  const source = path.join(root, 'safe.zip')
  for (const kind of ['file', 'folder', 'link']) {
    const target = path.join(root, `existing-${kind}`)
    if (kind === 'file') await fs.writeFile(target, 'keep')
    else if (kind === 'folder') await fs.mkdir(target)
    else if (process.platform !== 'win32') await fs.symlink(root, target)
    else continue
    await assert.rejects(performArchive(request('extract', source, path.basename(target))), { code: 'EARCHIVE_PUBLISH' })
    if (kind === 'file') assert.equal(await fs.readFile(target, 'utf8'), 'keep')
    if (kind === 'link') assert.ok((await fs.lstat(target)).isSymbolicLink())
  }
})
test('cancel running child kills it and cleans staging; source links/root escapes fail', options, async () => {
  const source = path.join(root, 'cancellable.bin')
  const file = await fs.open(source, 'w'); await file.truncate(64 * 1024 * 1024); await file.close()
  const controller = new AbortController()
  await assert.rejects(performArchive(request('create', source, 'cancelled.zip'), {
    signal: controller.signal, onProgress: () => controller.abort(),
  }), { code: 'ECANCELLED' })
  await assert.rejects(fs.stat(path.join(root, 'cancelled.zip')), { code: 'ENOENT' })
  assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.vesperwind-archive-')))
  await assert.rejects(performArchive(request('extract', path.join(fixtures, 'safe.zip'), 'outside')), { code: 'EOUTSIDE_ROOT' })
  if (process.platform !== 'win32') {
    const link = path.join(root, 'source-link'); await fs.symlink(source, link)
    await assert.rejects(performArchive(request('create', link, 'link.zip')), { code: 'EARCHIVE_UNSAFE_ENTRY' })
    const folder = path.join(root, 'contains-link'); await fs.mkdir(folder); await fs.symlink(source, path.join(folder, 'link'))
    await assert.rejects(performArchive(request('create', folder, 'contains-link.zip')), { code: 'EARCHIVE_UNSAFE_ENTRY' })
  }
})
test('archive handlers reject concurrent jobs and cancel on disconnect', async () => {
  const handlers = new Map(), acknowledgements = []
  const socket = { on: (name, handler) => handlers.set(name, handler), emit: () => {} }
  registerArchiveHandlers(socket)
  handlers.get('archive:start')({ ...request('create', '/missing', 'missing.zip'), jobId: 'first' }, (value) => acknowledgements.push(value))
  handlers.get('archive:start')({ ...request('create', '/missing', 'missing.zip'), jobId: 'second' }, (value) => acknowledgements.push(value))
  assert.equal(acknowledgements[0].ok, true); assert.equal(acknowledgements[1].error.code, 'EARCHIVE_BUSY')
  handlers.get('disconnect')()
})
test('missing sidecar produces diagnostics instead of running a system archive command', async () => {
  await assert.rejects(runWorker(path.join(root, 'missing-worker'), ['--version']), { code: 'EARCHIVE_SIDECAR' })
})
