import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  bootstrapPolicy, cacheDirectory, chooseBuildMode, missingPackages, msysPath, parseArguments,
  parseToolchainReport, selectPlatform, toolchainProblem, usableWindowsBuildPath, windowsPackages, windowsTools,
} from '../scripts/libmpv-build/options.js'
import { msysCandidates, readCacheState, sourcesHash } from '../scripts/libmpv-build/windows.js'
import { resolveDeveloperDirectory, spacelessDirectory } from '../scripts/libmpv-build/macos.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vw-libmpv-build-'))
const write = (root, file, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

test('npm run build:libmpv is the only documented entry point', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['build:libmpv'], 'node scripts/build-libmpv.js')
  for (const doc of ['docs/build-windows.md', 'docs/libmpv.md', 'src-tauri/vendor/libmpv/README.md']) {
    const text = fs.readFileSync(path.join(repo, doc), 'utf8')
    assert.match(text, /npm run build:libmpv/, doc)
    assert.doesNotMatch(text, /PresentationOnly|-MsysRoot|-BuildRoot|pacman -S|MSYSTEM=|build-libmpv-windows\.ps1|bash scripts\/build-libmpv/, doc)
  }
})

test('platform selection and argument parsing fail with one clear message', () => {
  assert.equal(selectPlatform('darwin'), 'macos')
  assert.equal(selectPlatform('win32'), 'windows')
  assert.throws(() => selectPlatform('linux'), /^Error: Bundled libmpv build is currently supported on macOS and Windows\.$/)
  assert.deepEqual(parseArguments([]), { clean: false, dryRun: false, ci: false, help: false })
  assert.deepEqual(parseArguments(['--clean', '--ci']), { clean: true, dryRun: false, ci: true, help: false })
  assert.throws(() => parseArguments(['--presentation-only']), /Unknown option --presentation-only/)
  const linux = spawnSync(process.execPath, [path.join(repo, 'scripts/build-libmpv.js')], {
    encoding: 'utf8', env: { ...process.env, VESPERWIND_LIBMPV_PLATFORM: 'linux' } })
  assert.equal(linux.status, 1)
  assert.equal(linux.stderr.trim(), 'Bundled libmpv build is currently supported on macOS and Windows.')
  assert.doesNotMatch(linux.stderr, /at .*\.js:\d+/)
})

test('CI only checks prerequisites; local builds may install them', () => {
  assert.deepEqual(bootstrapPolicy({}, { ci: false }), { install: true, ci: false })
  for (const environment of [{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }, { TF_BUILD: 'True' }]) {
    assert.deepEqual(bootstrapPolicy(environment, { ci: false }), { install: false, ci: true })
  }
  assert.deepEqual(bootstrapPolicy({ CI: 'false' }, { ci: false }), { install: true, ci: false })
  assert.deepEqual(bootstrapPolicy({}, { ci: true }), { install: false, ci: true })
})

test('build caches are stable platform caches outside the repository', () => {
  assert.equal(cacheDirectory('macos', {}, '/Users/dev', repo), '/Users/dev/Library/Caches/vesperwind-build/libmpv')
  assert.equal(cacheDirectory('windows', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, '', 'D:\\src\\vesperwind'),
    'C:\\Users\\dev\\AppData\\Local\\Vesperwind\\build\\libmpv')
  // A non-ASCII profile path falls back to a short system-drive cache.
  assert.equal(cacheDirectory('windows', { LOCALAPPDATA: 'C:\\Users\\Иван\\AppData\\Local', SystemDrive: 'D:' }, '', 'E:\\vesperwind'),
    'D:\\vesperwind-build\\libmpv')
  assert.equal(cacheDirectory('windows', { VESPERWIND_LIBMPV_BUILD_DIR: 'E:\\cache' }, '', 'D:\\vesperwind'), 'E:\\cache')
  assert.throws(() => cacheDirectory('windows', { VESPERWIND_LIBMPV_BUILD_DIR: 'E:\\my cache' }, '', 'D:\\vesperwind'), /short ASCII/)
  assert.throws(() => cacheDirectory('windows', { VESPERWIND_LIBMPV_BUILD_DIR: 'd:\\Vesperwind\\cache' }, '', 'D:\\vesperwind'), /outside the repository/)
  assert.throws(() => cacheDirectory('macos', { VESPERWIND_LIBMPV_BUILD_DIR: path.join(repo, 'cache') }, '/Users/dev', repo), /outside the repository/)
  assert.equal(usableWindowsBuildPath('C:\\Program Files\\x'), false)
})

test('incremental rebuild needs a complete cache from the same pins and toolchain', () => {
  const current = { sources: 'pins', toolchain: 'gcc 16' }
  const complete = { sources: 'pins', toolchain: 'gcc 16', complete: true, missing: [] }
  assert.deepEqual(chooseBuildMode(complete, current), { mode: 'presentation', reason: 'compatible build cache', clean: false })
  assert.deepEqual(chooseBuildMode({ ...complete, sources: null }, current), { mode: 'full', reason: 'no build cache yet', clean: true })
  assert.equal(chooseBuildMode({ ...complete, sources: 'old' }, current).clean, true)
  assert.deepEqual(chooseBuildMode({ ...complete, toolchain: 'gcc 15' }, current), { mode: 'full', reason: 'the cache was built with another toolchain', clean: true })
  // An interrupted full build of the same pins resumes instead of starting over.
  assert.deepEqual(chooseBuildMode({ ...complete, complete: false }, current), { mode: 'full', reason: 'the previous full build did not finish', clean: false })
  assert.match(chooseBuildMode({ ...complete, missing: ['SCHANNEL 1'] }, current).reason, /SCHANNEL/)
  assert.deepEqual(chooseBuildMode(complete, current, { clean: true }), { mode: 'full', reason: '--clean was requested', clean: true })
})

test('the Windows cache state is read from the build script stamps and FFmpeg evidence', () => {
  const root = temporary()
  try {
    assert.deepEqual(readCacheState(root).sources, null)
    write(root, 'cache-sources.sha256', `${sourcesHash()}\n`)
    write(root, 'cache-toolchain.txt', 'gcc.exe (Rev4, Built by MSYS2 project) 16.2.0\n')
    write(root, 'prefix-complete')
    for (const name of ['libavcodec', 'libavutil', 'freetype2', 'fribidi', 'harfbuzz', 'libass']) write(root, `prefix/lib/pkgconfig/${name}.pc`)
    write(root, 'build/ffmpeg/config.h', '#define CONFIG_SCHANNEL 1\r\n#define CONFIG_D3D11VA 1\r\n')
    write(root, 'build/ffmpeg/config_components.h', ['HTTPS_PROTOCOL', 'HLS_DEMUXER', 'H264_D3D11VA_HWACCEL', 'HEVC_D3D11VA_HWACCEL']
      .map((name) => `#define CONFIG_${name} 1`).join('\n'))
    write(root, 'build/ffmpeg-flags.txt', '--enable-schannel\n')
    write(root, 'build/d3d11va-probe.json', '{}')
    const state = readCacheState(root)
    assert.deepEqual(state, { sources: sourcesHash(), toolchain: 'gcc.exe (Rev4, Built by MSYS2 project) 16.2.0', complete: true, missing: [] })
    assert.equal(chooseBuildMode(state, { sources: sourcesHash(), toolchain: state.toolchain }).mode, 'presentation')
    // A cache from the earlier wrapper predates Schannel: full build.
    write(root, 'build/ffmpeg/config.h', '#define CONFIG_D3D11VA 1\n')
    assert.deepEqual(readCacheState(root).missing, ['SCHANNEL 1'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Windows packages and tools follow the build script', () => {
  const script = fs.readFileSync(path.join(repo, 'scripts/build-libmpv-windows.sh'), 'utf8')
  const checked = script.match(/for tool in ([^;]+); do/)[1].trim().split(/\s+/)
  for (const tool of checked) assert.ok(windowsTools.includes(tool), tool)
  assert.match(script, /-Ddovi=enabled -Dlibdovi=disabled/)
  assert.deepEqual(missingPackages(windowsPackages.join('\n')), [])
  assert.deepEqual(missingPackages(windowsPackages.filter((name) => !/nasm|shaderc/.test(name)).join('\r\n')),
    ['mingw-w64-ucrt-x86_64-nasm', 'mingw-w64-ucrt-x86_64-shaderc'])
  for (const name of ['mingw-w64-ucrt-x86_64-gcc', 'mingw-w64-ucrt-x86_64-spirv-cross', 'mingw-w64-ucrt-x86_64-python', 'make', 'git', 'curl']) {
    assert.ok(windowsPackages.includes(name), name)
  }
})

test('the UCRT64 check reports concrete problems', () => {
  const report = parseToolchainReport([
    ...windowsTools.map((tool) => `tool ${tool} /ucrt64/bin/${tool}`),
    'machine x86_64-w64-mingw32', 'msystem UCRT64', 'toolchain gcc.exe (Rev4, Built by MSYS2 project) 16.2.0', '',
  ].join('\r\n'))
  assert.equal(toolchainProblem(report), null)
  assert.equal(report.toolchain, 'gcc.exe (Rev4, Built by MSYS2 project) 16.2.0')
  assert.equal(toolchainProblem({ ...report, msystem: 'MSYS' }), 'the MSYS2 environment is MSYS, not UCRT64')
  assert.equal(toolchainProblem({ ...report, missing: ['nasm', 'cygpath'] }), 'missing UCRT64 tools: nasm, cygpath')
  assert.equal(toolchainProblem({ ...report, machine: 'x86_64-pc-msys' }), 'gcc targets x86_64-pc-msys, not x86_64-w64-mingw32')
  const check = fs.readFileSync(path.join(repo, 'scripts/libmpv-build/check-ucrt64.sh'), 'utf8')
  assert.equal(check.match(/for tool in ([^;]+); do/)[1].trim().split(/\s+/).join(' '), windowsTools.join(' '))
  assert.equal(msysPath('C:\\Users\\dev\\AppData\\Local\\Vesperwind\\build\\libmpv\\build-libmpv-windows.sh'),
    '/c/Users/dev/AppData/Local/Vesperwind/build/libmpv/build-libmpv-windows.sh')
  assert.equal(msysPath('D:\\'), '/d')
})

test('MSYS2 is found in its usual places without user input', () => {
  const candidates = msysCandidates({ SystemDrive: 'D:', USERPROFILE: 'C:\\Users\\dev', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', MSYS2_ROOT: 'F:\\m' },
    () => ['E:\\tools\\msys2'], 'G:\\msys\\msys2_shell.cmd')
  assert.deepEqual(candidates, ['F:\\m', 'D:\\msys64', 'C:\\msys64', 'C:\\tools\\msys64', 'C:\\Users\\dev\\scoop\\apps\\msys2\\current',
    'C:\\Users\\dev\\AppData\\Local\\msys64', 'G:\\msys', 'E:\\tools\\msys2'])
})

test('macOS finds Xcode without xcode-select and avoids spaces in build flags', { skip: process.platform !== 'darwin' }, () => {
  const root = temporary()
  try {
    const developer = path.join(root, 'Xcode.app/Contents/Developer')
    write(developer, 'usr/bin/xcodebuild')
    assert.equal(resolveDeveloperDirectory({ environment: { DEVELOPER_DIR: developer }, selected: '/Library/Developer/CommandLineTools', applications: [] }), developer)
    assert.equal(resolveDeveloperDirectory({ environment: {}, selected: '/Library/Developer/CommandLineTools', applications: [] }), null)
    const spaced = path.join(root, 'with space')
    const link = spacelessDirectory(spaced)
    assert.doesNotMatch(link, /\s/)
    assert.equal(fs.realpathSync(link), fs.realpathSync(spaced))
    fs.unlinkSync(link)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
