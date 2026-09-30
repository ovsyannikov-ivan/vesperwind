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
  for (const text of ['EXT:/PDR/default/ES.', '/tmp/%sXXXXXX', 'relative/source.c']) {
    assert.equal(hasAbsoluteBuildPath(text), false)
  }
})
