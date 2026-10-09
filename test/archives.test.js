import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { archiveName, extractionFolderName } from '../shared/archivePolicy.js'
import { compatibleArchiveWorker, archiveWorkerVersion } from '../shared/archiveWorkerPolicy.js'
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
test('archive fixture filenames are portable to Windows while unsafe entry names remain inside', async () => {
  for (const name of await fs.readdir(fixtures)) {
    assert.doesNotMatch(name, /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu, name)
    assert.doesNotMatch(name, /[<>:"\\|?*\x00-\x1f]|[. ]$/u, name)
  }
  const data = await fs.readFile(path.join(fixtures, 'reserved-nul.7z'))
  assert.ok(data.includes(Buffer.from('NUL.txt\0', 'utf16le')), 'the malicious entry is still tested')
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, '7z-manifest.json')))
  assert.equal(createHash('sha256').update(data).digest('hex'), manifest.archives['reserved-nul.7z'])
})
test('7z UI policy is case insensitive and does not advertise multipart; worker requires LZMA2', () => {
  for (const name of ['backup.7z', 'BACKUP.7Z', 'Archive.7z']) assert.equal(archiveName(name), true)
  assert.equal(extractionFolderName('backup.7z'), 'backup'); assert.equal(extractionFolderName('Archive.7Z'), 'Archive')
  for (const name of ['archive.7z.001', 'archive.7z.002']) assert.equal(archiveName(name), false)
  for (const name of ['archive.tar.gz', 'archive.tgz', 'archive.zip', 'archive.rar']) assert.equal(extractionFolderName(name), 'archive')
  assert.equal(compatibleArchiveWorker(archiveWorkerVersion), true)
  for (const version of [archiveWorkerVersion.split(' liblzma/')[0], archiveWorkerVersion.replace(',lzma2', ''), archiveWorkerVersion.replace('memory=536870912', 'memory=unlimited'), 'vesperwind-archive/1 libarchive/libarchive 3.8.9 zip,tar,tgz,rar,rar5']) assert.equal(compatibleArchiveWorker(version), false)
})
test('real 7z Copy, LZMA, LZMA2, solid and Unicode extraction is byte perfect with progress', options, async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, '7z-manifest.json')))
  for (const name of ['safe-copy.7z', 'safe-lzma.7z', 'safe-lzma2.7z', 'safe-solid-lzma2.7z', 'unicode-names.7z', 'safe-bcj-lzma2.7z']) {
    const source = path.join(root, name); await fs.copyFile(path.join(fixtures, name), source)
    const events = [], destination = `extracted-${name}`
    const result = await performArchive(request('extract', source, destination), { onProgress: event => {
      events.push(event); assert.equal(event.done, false)
      assert.equal(existsSync(path.join(root, destination)), false, 'no partial publication')
    } })
    assert.ok(events.length, `${name}: streamed progress`)
    const files = name === 'safe-bcj-lzma2.7z' ? ['branch.exe'] : Object.keys(manifest).filter(key => key.startsWith('folder/'))
    for (const file of files) {
      const data = await fs.readFile(path.join(result.destinationPath, file))
      assert.equal(createHash('sha256').update(data).digest('hex'), manifest[file].sha256, `${name}: ${file}`)
    }
    if (name !== 'safe-bcj-lzma2.7z') assert.equal((await fs.stat(path.join(result.destinationPath, 'folder/empty directory'))).isDirectory(), true)
    assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), manifest.archives[name], 'archive is unchanged')
    await assert.rejects(performArchive(request('extract', source, destination)), { code: 'EARCHIVE_PUBLISH' })
  }
})
test('real 7z rejects encrypted, damaged, unsafe and excessive-memory archives without publication', options, async () => {
  const cases = {
    'encrypted.7z': 'EARCHIVE_ENCRYPTED', 'encrypted-header.7z': 'EARCHIVE_ENCRYPTED',
    'corrupted.7z': 'EARCHIVE_FORMAT', 'truncated.7z': 'EARCHIVE_FORMAT', 'huge-dictionary.7z': 'EARCHIVE_LIMIT',
    'unsafe-link.7z': 'EARCHIVE_UNSAFE_ENTRY',
    'unsupported-bzip2.7z': 'EARCHIVE_UNSUPPORTED_CODEC', 'duplicate.7z': 'EARCHIVE_FORMAT',
  }
  for (const name of ['dotdot', 'absolute', 'drive', 'unc', 'ads', 'reserved', 'reserved-nul', 'trailing', 'backslash', 'control']) cases[`${name}.7z`] = 'EARCHIVE_UNSAFE_PATH'
  for (const [name, code] of Object.entries(cases)) {
    const source = path.join(root, name); await fs.copyFile(path.join(fixtures, name), source)
    const destination = `rejected-${name}`
    await assert.rejects(performArchive(request('extract', source, destination)), { code }, name)
    await assert.rejects(fs.stat(path.join(root, destination)), { code: 'ENOENT' })
    assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.vesperwind-archive-')), name)
  }
  await assert.rejects(fs.stat(path.join(root, 'outside.txt')), { code: 'ENOENT' })
})
test('7z cancellation kills the worker and cleans staged output', options, async () => {
  const source = path.join(root, 'large-solid-lzma2.7z'); await fs.copyFile(path.join(fixtures, 'large-solid-lzma2.7z'), source)
  const controller = new AbortController()
  await assert.rejects(performArchive(request('extract', source, 'cancelled-7z'), { signal: controller.signal, onProgress: () => controller.abort() }), { code: 'ECANCELLED' })
  await assert.rejects(fs.stat(path.join(root, 'cancelled-7z')), { code: 'ENOENT' })
  assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.vesperwind-archive-')))
})
test('large solid LZMA2 streams 384 MiB, hashes nested files and emits bounded progress', options, async () => {
  const source = path.join(root, 'large-solid-lzma2.7z')
  await fs.copyFile(path.join(fixtures, 'large-solid-lzma2.7z'), source)
  const events = [], started = Date.now()
  const result = await performArchive(request('extract', source, 'large-output'), { onProgress: event => {
    events.push(event)
    assert.equal(existsSync(path.join(root, 'large-output')), false)
  } })
  assert.ok(events.length)
  assert.ok(events.length <= Math.ceil((Date.now() - started) / 1000) + 2, 'bounded event rate')
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, '7z-manifest.json')))
  for (const [name, expected] of Object.entries(manifest.large)) {
    const file = path.join(result.destinationPath, name), digest = createHash('sha256')
    assert.equal((await fs.stat(file)).size, expected.size)
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    assert.equal(digest.digest('hex'), expected.sha256)
  }
})
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
