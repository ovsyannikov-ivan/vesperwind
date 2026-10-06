import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inspectPe, isSystemDll } from './libmpv-pe.js'
import { checkDoviManifest, checkWindowsDoviEvidence } from './libmpv-dovi.js'

export function hasAbsoluteBuildPath(text) {
  // FFmpeg's file.c contains a portable runtime tempfile template, not a build path.
  const strings = text.replaceAll('/tmp/%sXXXXXX', '')
    // Fixed upstream MSYS2 CRT assertion filename in the reviewed shaderc
    // package. This is not a Vesperwind/user build path. Keep the exception
    // exact: arbitrary drive paths and other toolchain paths remain forbidden.
    .replaceAll('D:/W/B/src/mingw-w64/mingw-w64-crt/crt/tls_atexit.c', '')
  // Require a drive-letter boundary: GXF's EXT:/PDR/ is a format identifier.
  return /(?<![a-z])[a-z]:[\\/][a-z0-9_. -]+[\\/]/i.test(strings) ||
    /\/(?:home|tmp|ucrt64)\//.test(strings)
}

export async function verifyWindowsBundle(directory, manifest) {
  const files = await fs.readdir(directory, { recursive: true })
  const names = files.map((name) => name.replaceAll('\\', '/'))
  const dlls = names.filter((name) => /\.dll$/i.test(name))
  if (!dlls.includes('mpv-2.dll')) throw new Error('Missing mpv-2.dll')
  if (names.some((name) => /(?:^|\/)mpv\.exe$/i.test(name))) throw new Error('mpv.exe is forbidden')
  if (dlls.some((name) => name.includes('/'))) throw new Error('Runtime DLLs must be colocated')
  const bundled = new Set(dlls.map((name) => name.toLowerCase()))
  if (bundled.size !== dlls.length) throw new Error('Case-insensitive duplicate DLL')
  const closure = {}
  for (const name of dlls) {
    const data = await fs.readFile(path.join(directory, name))
    const pe = inspectPe(data)
    closure[name] = pe.imports
    for (const dependency of pe.imports) {
      if (!bundled.has(dependency) && !isSystemDll(dependency)) {
        throw new Error(`${name}: missing or unexpected external DLL ${dependency}`)
      }
    }
    // Build-prefix remapping should remove source/build paths from PE strings.
    for (const text of [data.toString('latin1'), data.toString('utf16le')]) {
      if (hasAbsoluteBuildPath(text)) throw new Error(`${name}: absolute build-machine path`)
    }
  }
  const info = JSON.parse(await fs.readFile(path.join(directory, 'BUILD-INFO.txt'), 'utf8'))
  if (info.architecture !== 'x86_64' || !info.toolchain || info.minimumWindows !== '10') {
    throw new Error('Missing Windows architecture/toolchain/minimum-version evidence')
  }
  if (!closure['avformat-62.dll']?.includes('secur32.dll') || !closure['avformat-62.dll']?.includes('crypt32.dll')) throw new Error('Bundled avformat lacks native Schannel TLS imports')
  if (!info.ffmpegFlags?.includes('--enable-schannel') && info.networkComponent?.tlsBackend !== 'schannel') throw new Error('Missing Schannel build evidence')
  const pins = { mpv: manifest.mpvVersion, mpvCommit: manifest.mpvCommit, ...manifest.dependencies }
  for (const [name, value] of Object.entries(pins)) {
    if (info.sources?.[name] !== value) throw new Error(`Unconfirmed source pin: ${name}`)
  }
  for (const flag of ['--disable-gpl', '--disable-nonfree', '--disable-version3', '--enable-d3d11va']) {
    if (!info.ffmpegFlags?.includes(flag)) throw new Error(`Missing FFmpeg flag: ${flag}`)
  }
  for (const flag of [...manifest.requiredMesonOptions, ...(manifest.windows.requiredMesonOptions ?? []), '-Dd3d-hwaccel=enabled', '-Dwasapi=enabled']) {
    if (!info.mpvFlags?.includes(flag)) throw new Error(`Missing mpv flag: ${flag}`)
  }
  for (const flag of manifest.windows.requiredLibplaceboOptions ?? []) {
    if (!info.libplaceboOptions?.includes(flag)) throw new Error(`Missing libplacebo flag: ${flag}`)
  }
  const dovi = checkDoviManifest(manifest.windows)
  checkWindowsDoviEvidence(info, dovi.artifact)
  if (dovi.pending) {
    console.warn(`Windows artifact has libplacebo -Ddovi=${dovi.artifact}; the build recipe has -Ddovi=${dovi.recipe}. Rebuild with scripts/build-libmpv-windows.ps1.`)
  }
  for (const [name, version] of Object.entries(manifest.windows.shaderToolchainPackages ?? {})) {
    if (!info.toolchainPackages?.includes(`${name} ${version}`)) throw new Error(`Unconfirmed shader package: ${name}`)
  }
  if (manifest.windows.requiredMesonOptions?.includes('-Dd3d11=enabled')) {
    for (const name of ['libshaderc_shared.dll', 'libspirv-cross-c-shared.dll']) {
      if (!bundled.has(name)) throw new Error(`Missing D3D11 shader dependency: ${name}`)
    }
    for (const name of ['shaderc', 'spirv-cross', 'glslang', 'spirv-tools']) {
      if (!names.some((file) => file.startsWith(`LICENSES/${name}/`))) throw new Error(`Missing shader license: ${name}`)
    }
  }
  if (info.d3d11va?.h264 !== true || info.d3d11va?.hevc !== true) {
    throw new Error('Missing FFmpeg H.264/HEVC D3D11VA probe evidence')
  }
  if (!names.some((name) => name.startsWith('LICENSES/'))) throw new Error('Empty LICENSES')
  if (!(await fs.readFile(path.join(directory, 'SOURCE-OFFER.txt'), 'utf8')).trim()) {
    throw new Error('Empty source offer')
  }
  const sums = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')
  const checked = new Set()
  for (const line of sums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) throw new Error('Malformed SHA256SUMS')
    const [, expected, name] = match
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes(':') || checked.has(name)) {
      throw new Error(`Unsafe/duplicate checksum path: ${name}`)
    }
    const actual = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')
    if (actual !== expected) throw new Error(`Checksum mismatch: ${name}`)
    checked.add(name)
  }
  for (const name of names) {
    if (name !== 'SHA256SUMS' && (await fs.stat(path.join(directory, name))).isFile() && !checked.has(name)) {
      throw new Error(`File absent from SHA256SUMS: ${name}`)
    }
  }
  return closure
}
