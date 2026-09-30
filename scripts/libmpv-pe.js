// Minimal, bounds-checked PE32+ inspector: normal and delay-load imports.
// Runs on stock Node, including a Windows machine without dumpbin/MSYS2.
export function inspectPe(data) {
  const check = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > data.length) {
      throw new Error('Truncated or invalid PE data')
    }
    return offset
  }
  const u16 = (o) => data.readUInt16LE(check(o, 2))
  const u32 = (o) => data.readUInt32LE(check(o, 4))
  if (u16(0) !== 0x5a4d) throw new Error('Missing DOS signature')
  const pe = u32(0x3c)
  if (u32(pe) !== 0x4550) throw new Error('Missing PE signature')
  if (u16(pe + 4) !== 0x8664) throw new Error('Expected x86_64 PE machine')
  const optional = pe + 24
  if (u16(optional) !== 0x20b) throw new Error('Expected PE32+')
  if (!(u16(pe + 22) & 0x2000)) throw new Error('Expected a DLL')
  const sectionCount = u16(pe + 6)
  const optionalSize = u16(pe + 20)
  check(optional, optionalSize)
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const o = optional + optionalSize + i * 40
    check(o, 40)
    return { rva: u32(o + 12), size: u32(o + 16), raw: u32(o + 20) }
  })
  const offset = (rva, size = 1) => {
    if (rva < u32(optional + 60)) return check(rva, size)
    const section = sections.find((s) => rva >= s.rva && rva + size <= s.rva + s.size)
    if (!section) throw new Error(`Unmapped PE RVA ${rva}`)
    return check(section.raw + rva - section.rva, size)
  }
  const string = (rva) => {
    const start = offset(rva)
    const end = data.indexOf(0, start)
    if (end < start || end - start > 260) throw new Error('Invalid PE import name')
    offset(rva, end - start + 1)
    const name = data.toString('ascii', start, end)
    if (!/^[a-z0-9_.+-]+\.dll$/i.test(name)) throw new Error(`Invalid DLL import: ${name}`)
    return name.toLowerCase()
  }
  const imports = new Set()
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (u32(optional + 108) <= index) continue
    const dir = optional + 112 + index * 8
    if (dir + 8 > optional + optionalSize) throw new Error('Invalid PE data directory')
    const rva = u32(dir)
    const size = u32(dir + 4)
    if (!rva && !size) continue
    let terminated = false
    for (let position = 0; position + stride <= size; position += stride) {
      const o = offset(rva + position, stride)
      if (data.subarray(o, o + stride).every((b) => b === 0)) { terminated = true; break }
      if (index === 13 && u32(o) !== 1) throw new Error('Unsupported VA delay import')
      imports.add(string(u32(o + nameOffset)))
    }
    if (!terminated) throw new Error('Unterminated PE import table')
  }
  return { architecture: 'x86_64', imports: [...imports].sort() }
}

// Explicit OS contract, not "whatever DLL happens to exist on this machine".
export const systemDlls = new Set([
  'advapi32.dll', 'avrt.dll', 'bcrypt.dll', 'cfgmgr32.dll', 'comctl32.dll',
  'comdlg32.dll', 'crypt32.dll', 'd3d11.dll', 'd3d9.dll', 'dcomp.dll',
  'dwmapi.dll', 'dwrite.dll', 'dxgi.dll', 'dxva2.dll', 'gdi32.dll', 'imm32.dll',
  'iphlpapi.dll', 'kernel32.dll', 'ksuser.dll', 'mf.dll', 'mfplat.dll',
  'mfreadwrite.dll', 'mfuuid.dll', 'mmdevapi.dll', 'msvcrt.dll', 'ncrypt.dll',
  'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'opengl32.dll',
  'powrprof.dll', 'propsys.dll', 'psapi.dll', 'rpcrt4.dll', 'secur32.dll',
  'setupapi.dll', 'shcore.dll', 'shell32.dll', 'shlwapi.dll', 'ucrtbase.dll', 'user32.dll',
  'userenv.dll', 'usp10.dll', 'uxtheme.dll', 'version.dll', 'winmm.dll',
  'winspool.drv', 'ws2_32.dll', 'wtsapi32.dll',
])
export const isSystemDll = (name) => systemDlls.has(name.toLowerCase()) ||
  /^api-ms-win-(?:core|crt|security)-[a-z0-9-]+\.dll$/i.test(name)
