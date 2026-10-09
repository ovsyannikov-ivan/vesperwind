import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { patchArchive7zip } from './patch-archive-7zip.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = process.env.VESPERWIND_ARCHIVE_BUILD_DIR || path.join(os.tmpdir(), 'vesperwind-archive-sources')
const sources = JSON.parse(await fs.readFile(new URL('./archive-sources.json', import.meta.url)))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed (${result.status})`)
}
// The Windows sidecar is an MSVC build (Release subdirectory of a Visual Studio
// generator). A CMake on PATH, such as Strawberry Perl's, may predate the
// installed Visual Studio and silently fall back to Ninja and MinGW gcc, so use
// the CMake that ships with Visual Studio when it is available.
const visualStudioCmake = () => {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const result = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-find', 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : undefined
}
const cmake = (process.platform === 'win32' && visualStudioCmake()) || 'cmake'
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
  // Re-extract verified bytes so a modified source cache cannot enter a release.
  await fs.rm(directory, { recursive: true, force: true })
  run(cmake, ['-E', 'chdir', work, cmake, '-E', 'tar', 'xf', archive])
}
await patchArchive7zip(path.join(work, `libarchive-${sources.libarchive.version}`))
// libarchive replaces CMAKE_MODULE_PATH with its own directory; install the
// pinned-target finder there so no host liblzma can be discovered accidentally.
await fs.copyFile(path.join(root, 'native/archive-worker/cmake/FindLibLZMA.cmake'),
  path.join(work, `libarchive-${sources.libarchive.version}`, 'build/cmake/FindLibLZMA.cmake'))
const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1]
if (!host || !/apple-darwin|unknown-linux-gnu|pc-windows-msvc/.test(host)) throw new Error('Unsupported native build target')
const build = path.join(work, `build-${host}`)
// A build directory configured by another generator (for example a MinGW
// fallback) cannot be reconfigured; start it over.
const generator = (await fs.readFile(path.join(build, 'CMakeCache.txt'), 'utf8').catch(() => ''))
  .match(/^CMAKE_GENERATOR:INTERNAL=(.+)$/m)?.[1]?.trim()
if (process.platform === 'win32' && generator && !generator.startsWith('Visual Studio')) await fs.rm(build, { recursive: true, force: true })
run(cmake, ['-S', path.join(root, 'native/archive-worker'), '-B', build,
  `-DLIBARCHIVE_SOURCE=${path.join(work, `libarchive-${sources.libarchive.version}`)}`,
  `-DZLIB_SOURCE=${path.join(work, `zlib-${sources.zlib.version}`)}`,
  `-DXZ_SOURCE=${path.join(work, `xz-${sources.xz.version}`)}`, '-DCMAKE_BUILD_TYPE=Release'])
run(cmake, ['--build', build, '--config', 'Release', '--target', 'vesperwind-archive', 'archive-space-test', 'archive-memory-test', '--parallel', '8'])
const suffix = process.platform === 'win32' ? '.exe' : ''
const binary = path.join(build, process.platform === 'win32' ? 'Release' : '', `vesperwind-archive${suffix}`)
const spaceTest = path.join(build, process.platform === 'win32' ? 'Release' : '', `archive-space-test${suffix}`)
run(path.join(build, process.platform === 'win32' ? 'Release' : '', `archive-memory-test${suffix}`), [])
for (const scenario of ['limits', 'low', 'unknown', 'pressure', 'stream']) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-archive-space-test-'))
  try { run(spaceTest, [scenario, path.join(root, 'test/fixtures/archives/safe.tar')], { cwd }) }
  finally { await fs.rm(cwd, { recursive: true, force: true }) }
}
run(binary, ['--version'])
// Check actual pinned codecs at build time, before a stale/incomplete binary can
// enter a bundle. The decoded file is not published outside this private test.
for (const fixture of ['safe-copy.7z', 'safe-lzma.7z', 'safe-lzma2.7z', 'safe-solid-lzma2.7z']) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-archive-codec-test-'))
  try { run(binary, ['extract', path.join(root, 'test/fixtures/archives', fixture)], { cwd }) }
  finally { await fs.rm(cwd, { recursive: true, force: true }) }
}
const destination = path.join(root, 'src-tauri/binaries')
await fs.mkdir(destination, { recursive: true })
await fs.copyFile(binary, path.join(destination, `vesperwind-archive-${host}${suffix}`))
await fs.chmod(path.join(destination, `vesperwind-archive-${host}${suffix}`), 0o755)
await fs.copyFile(path.join(work, `libarchive-${sources.libarchive.version}`, 'COPYING'), path.join(destination, 'libarchive-LICENSE.txt'))
await fs.copyFile(path.join(work, `zlib-${sources.zlib.version}`, 'LICENSE'), path.join(destination, 'zlib-LICENSE.txt'))
await fs.copyFile(path.join(work, `xz-${sources.xz.version}`, 'COPYING.0BSD'), path.join(destination, 'liblzma-LICENSE.txt'))
await fs.writeFile(path.join(destination, 'archive-BUILD-INFO.json'), `${JSON.stringify({ host, protocol: 1, sources, codecs: ['copy', 'lzma', 'lzma2'], memoryBudget: 512 * 1024 * 1024, patches: ['bounded-7zip-allocator'] }, null, 2)}\n`)
run(path.join(destination, `vesperwind-archive-${host}${suffix}`), ['--version'])
