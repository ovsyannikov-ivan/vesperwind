import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = process.env.VESPERWIND_ARCHIVE_BUILD_DIR || path.join(os.tmpdir(), 'vesperwind-archive-sources')
const sources = JSON.parse(await fs.readFile(new URL('./archive-sources.json', import.meta.url)))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed (${result.status})`)
}
await fs.mkdir(work, { recursive: true })
for (const [name, source] of Object.entries(sources)) {
  const archive = path.join(work, path.basename(new URL(source.url).pathname))
  try { await fs.access(archive) } catch {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`Download failed: ${source.url}`)
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()))
  }
  const hash = createHash('sha256').update(await fs.readFile(archive)).digest('hex')
  if (hash !== source.sha256) throw new Error(`${name}: source checksum mismatch`)
  const directory = path.join(work, `${name}-${source.version}`)
  try { await fs.access(directory) } catch { run('cmake', ['-E', 'chdir', work, 'cmake', '-E', 'tar', 'xf', archive]) }
}
const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1]
if (!host || !/apple-darwin|unknown-linux-gnu|pc-windows-msvc/.test(host)) throw new Error('Unsupported native build target')
const build = path.join(work, `build-${host}`)
run('cmake', ['-S', path.join(root, 'native/archive-worker'), '-B', build,
  `-DLIBARCHIVE_SOURCE=${path.join(work, `libarchive-${sources.libarchive.version}`)}`,
  `-DZLIB_SOURCE=${path.join(work, `zlib-${sources.zlib.version}`)}`, '-DCMAKE_BUILD_TYPE=Release'])
run('cmake', ['--build', build, '--config', 'Release', '--target', 'vesperwind-archive', 'archive-space-test', '--parallel', '8'])
const suffix = process.platform === 'win32' ? '.exe' : ''
const binary = path.join(build, process.platform === 'win32' ? 'Release' : '', `vesperwind-archive${suffix}`)
const spaceTest = path.join(build, process.platform === 'win32' ? 'Release' : '', `archive-space-test${suffix}`)
for (const scenario of ['limits', 'low', 'unknown', 'pressure', 'stream']) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-archive-space-test-'))
  try { run(spaceTest, [scenario, path.join(root, 'test/fixtures/archives/safe.tar')], { cwd }) }
  finally { await fs.rm(cwd, { recursive: true, force: true }) }
}
const destination = path.join(root, 'src-tauri/binaries')
await fs.mkdir(destination, { recursive: true })
await fs.copyFile(binary, path.join(destination, `vesperwind-archive-${host}${suffix}`))
await fs.chmod(path.join(destination, `vesperwind-archive-${host}${suffix}`), 0o755)
await fs.copyFile(path.join(work, `libarchive-${sources.libarchive.version}`, 'COPYING'), path.join(destination, 'libarchive-LICENSE.txt'))
await fs.copyFile(path.join(work, `zlib-${sources.zlib.version}`, 'LICENSE'), path.join(destination, 'zlib-LICENSE.txt'))
await fs.writeFile(path.join(destination, 'archive-BUILD-INFO.json'), `${JSON.stringify({ host, protocol: 1, sources }, null, 2)}\n`)
run(path.join(destination, `vesperwind-archive-${host}${suffix}`), ['--version'])
