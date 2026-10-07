import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectPe, isSystemDll } from '../scripts/libmpv-pe.js'
import { hasAbsoluteBuildPath } from '../scripts/verify-libmpv-windows.js'

function fixture({ dependency = 'kernel32.dll', delay = false } = {}) {
  const data = Buffer.alloc(1024)
  data.writeUInt16LE(0x5a4d, 0)
  data.writeUInt32LE(0x80, 0x3c)
  data.writeUInt32LE(0x4550, 0x80)
  data.writeUInt16LE(0x8664, 0x84)
  data.writeUInt16LE(1, 0x86)
  data.writeUInt16LE(240, 0x94)
  data.writeUInt16LE(0x2000, 0x96)
  const optional = 0x98
  data.writeUInt16LE(0x20b, optional)
  data.writeUInt32LE(512, optional + 60)
  data.writeUInt32LE(16, optional + 108)
  const directory = optional + 112 + (delay ? 13 : 1) * 8
  data.writeUInt32LE(0x1000, directory)
  data.writeUInt32LE(delay ? 64 : 40, directory + 4)
  const section = optional + 240
  data.writeUInt32LE(0x1000, section + 12)
  data.writeUInt32LE(512, section + 16)
  data.writeUInt32LE(512, section + 20)
  if (delay) data.writeUInt32LE(1, 512)
  data.writeUInt32LE(0x1080, 512 + (delay ? 4 : 12))
  data.write(dependency + '\0', 640, 'ascii')
  return data
}

test('PE inspection reads normal and delay imports without an installed toolchain', () => {
  assert.deepEqual(inspectPe(fixture()).imports, ['kernel32.dll'])
  assert.deepEqual(inspectPe(fixture({ delay: true, dependency: 'avcodec-62.dll' })).imports, ['avcodec-62.dll'])
})
test('PE inspection rejects wrong architecture, truncated files and path imports', () => {
  const x86 = fixture()
  x86.writeUInt16LE(0x14c, 0x84)
  assert.throws(() => inspectPe(x86), /x86_64/)
  assert.throws(() => inspectPe(fixture().subarray(0, 650)), /Invalid|Truncated/)
  assert.throws(() => inspectPe(fixture({ dependency: 'C:\\msys64\\bad.dll' })), /Invalid DLL/)
})
test('PE inspection rejects unterminated import descriptors', () => {
  const data = fixture()
  data.writeUInt32LE(20, 0x98 + 112 + 8 + 4)
  assert.throws(() => inspectPe(data), /Unterminated/)
})
test('system DLL policy never treats arbitrary locally installed runtimes as Windows DLLs', () => {
  assert.equal(isSystemDll('KERNEL32.DLL'), true)
  assert.equal(isSystemDll('api-ms-win-crt-runtime-l1-1-0.dll'), true)
  for (const name of ['msys-2.0.dll', 'libgcc_s_seh-1.dll', 'avcodec-62.dll', 'codec.dll']) {
    assert.equal(isSystemDll(name), false)
  }
})

test('build-path checks distinguish upstream runtime templates from machine paths', () => {
  for (const text of ['C:/Temp/build/source.c', 'D:\\work\\mpv\\file.c', '/home/builder/file.c', '/tmp/build/file.c', '/ucrt64/include/file.h']) {
    assert.equal(hasAbsoluteBuildPath(text), true)
  }
  for (const text of ['EXT:/PDR/default/ES.', '/tmp/%sXXXXXX', 'relative/source.c',
    'D:/W/B/src/mingw-w64/mingw-w64-crt/crt/tls_atexit.c']) {
    assert.equal(hasAbsoluteBuildPath(text), false)
  }
  assert.equal(hasAbsoluteBuildPath('D:/W/B/src/private-project/file.c'), true)
})

test('Dolby Vision provenance requires built-in dovi evidence and never libdovi', async () => {
  const { doviNote, doviState, checkDoviManifest, checkMacosDoviEvidence, checkWindowsDoviEvidence } = await import('../scripts/libmpv-dovi.js')
  const enabled = ['-Ddovi=enabled', '-Dlibdovi=disabled'], disabled = ['-Ddovi=disabled', '-Dlibdovi=disabled']
  assert.equal(doviState(enabled), 'enabled')
  assert.equal(doviState(disabled), 'disabled')
  assert.throws(() => doviState(['-Ddovi=enabled', '-Dlibdovi=enabled']), /libdovi=disabled/)
  assert.throws(() => doviState(['-Dlibdovi=disabled']), /-Ddovi=/)
  assert.deepEqual(checkDoviManifest({ requiredLibplaceboOptions: enabled, doviProcessing: doviNote('enabled') }),
    { artifact: 'enabled', recipe: 'enabled', pending: false })
  // A manifest note cannot claim reshaping the artifact options do not build.
  assert.throws(() => checkDoviManifest({ requiredLibplaceboOptions: disabled, doviProcessing: doviNote('enabled') }), /doviProcessing/)

  const macos = 'libplacebo dovi: enabled; libdovi: disabled\nlibplacebo pkg-config: pl_has_dovi=1 pl_has_libdovi=0\nmpv Dolby Vision metadata mapping: PL_HAVE_LAV_DOLBY_VISION defined (PL_API_VER 351)'
  checkMacosDoviEvidence(macos, 'enabled')
  assert.throws(() => checkMacosDoviEvidence(macos.replace('pl_has_dovi=1', 'pl_has_dovi=0'), 'enabled'), /pl_has_dovi=1/)
  assert.throws(() => checkMacosDoviEvidence(macos.split('\n').slice(0, 2).join('\n'), 'enabled'), /PL_HAVE_LAV_DOLBY_VISION/)
  assert.throws(() => checkMacosDoviEvidence(macos.replace('pl_has_libdovi=0', 'pl_has_libdovi=1'), 'enabled'), /libdovi/)
  assert.throws(() => checkMacosDoviEvidence(macos, 'disabled'), /dovi: disabled/)

  const windows = { libplaceboOptions: ['-Dd3d11=enabled', ...enabled], libplaceboPkgConfig: { pl_has_dovi: '1', pl_has_libdovi: '0' },
    doviMapping: 'mpv Dolby Vision metadata mapping: PL_HAVE_LAV_DOLBY_VISION defined (PL_API_VER 351)' }
  checkWindowsDoviEvidence(windows, 'enabled')
  assert.throws(() => checkWindowsDoviEvidence({ ...windows, doviMapping: undefined }, 'enabled'), /mapping/)
  assert.throws(() => checkWindowsDoviEvidence({ ...windows, libplaceboPkgConfig: undefined }, 'enabled'), /pl_has_dovi=1/)
  assert.throws(() => checkWindowsDoviEvidence({ ...windows, libplaceboPkgConfig: { pl_has_dovi: '1', pl_has_libdovi: '1' } }, 'enabled'), /libdovi/)
  // An artifact built with dovi disabled cannot satisfy an enabled artifact entry.
  assert.throws(() => checkWindowsDoviEvidence({ libplaceboOptions: disabled }, 'enabled'), /-Ddovi=enabled/)
  checkWindowsDoviEvidence({ libplaceboOptions: disabled }, 'disabled')
})

test('Windows Dolby Vision handoff keeps recipe and checked-in artifact explicit', async () => {
  const { doviNote, checkDoviManifest, recordBuiltArtifact, checkWindowsDoviEvidence } = await import('../scripts/libmpv-dovi.js')
  const fs = await import('node:fs/promises')
  const manifest = JSON.parse(await fs.readFile(new URL('../src-tauri/vendor/libmpv/manifest.json', import.meta.url), 'utf8'))
  const info = JSON.parse(await fs.readFile(new URL('../src-tauri/vendor/libmpv/windows/BUILD-INFO.txt', import.meta.url), 'utf8'))
  const script = await fs.readFile(new URL('../scripts/build-libmpv-windows.sh', import.meta.url), 'utf8')
  // The recipe in the manifest is what the build script asks Meson for.
  for (const flag of manifest.windows.buildRecipeLibplaceboOptions.filter((flag) => /dovi/.test(flag))) assert.ok(script.includes(flag), flag)

  // The checked-in artifact was rebuilt from the recipe: packaging recorded the
  // Meson result, and the build evidence shows built-in dovi without libdovi.
  assert.deepEqual(checkDoviManifest(manifest.windows), { artifact: 'enabled', recipe: 'enabled', pending: false })
  assert.equal(manifest.windows.doviProcessing, doviNote('enabled'))
  assert.equal('artifactPendingRebuild' in manifest.windows, false)
  checkWindowsDoviEvidence(info, 'enabled')
  assert.throws(() => checkWindowsDoviEvidence(info, 'disabled'))
  assert.throws(() => checkDoviManifest({ ...manifest.windows, artifactPendingRebuild: true }), /matches its build recipe/)
  assert.deepEqual(recordBuiltArtifact(manifest.windows, info.libplaceboOptions), manifest.windows)
  // A build that ignored the recipe is never recorded.
  const ignored = info.libplaceboOptions.map((flag) => flag === '-Ddovi=enabled' ? '-Ddovi=disabled' : flag)
  assert.throws(() => recordBuiltArtifact(manifest.windows, ignored), /recipe requires -Ddovi=enabled/)
})
