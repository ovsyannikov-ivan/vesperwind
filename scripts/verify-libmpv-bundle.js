import fs from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyWindowsBundle } from './verify-libmpv-windows.js'
import { checkDoviManifest, checkMacosDoviEvidence } from './libmpv-dovi.js'

const root = fileURLToPath(new URL('../src-tauri/vendor/libmpv', import.meta.url))
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
const platform = process.argv[2] || process.platform
const platformName = platform === 'darwin' || platform === 'macos' ? 'macos' : platform
const entry = platformName === 'macos' ? manifest.macosEntry : manifest.windowsEntry

if (!['macos', 'windows', 'win32'].includes(platformName)) {
  throw new Error(`Unsupported libmpv bundle platform: ${platform}`)
}
if (manifest.artifactStatus !== 'built-from-pinned-source') {
  throw new Error('libmpv artifacts are not built from the reviewed pinned source set')
}
await fs.access(path.join(root, entry))

const directory = path.join(root, path.dirname(entry))
const files = await fs.readdir(directory)
if (files.some((name) => /^mpv(?:\.exe)?$/i.test(name))) {
  throw new Error('The bundle must contain libmpv, not an external mpv process')
}
for (const required of ['LICENSES', 'SOURCE-OFFER.txt', 'SHA256SUMS', 'BUILD-INFO.txt']) {
  await fs.access(path.join(directory, required))
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} verification failed: ${result.error?.message || result.stderr || result.stdout}`)
  }
  return result.stdout
}

if (platformName === 'windows' || platformName === 'win32') {
  const closure = await verifyWindowsBundle(directory, manifest)
  console.log(JSON.stringify(closure, null, 2))
}

if (platformName === 'macos') {
  if (manifest.macos.hardwareDecode !== true) {
    throw new Error('macOS manifest must record the verified VideoToolbox build')
  }
  const buildInfo = await fs.readFile(path.join(directory, 'BUILD-INFO.txt'), 'utf8')
  for (const evidence of [
    '--disable-gpl --disable-nonfree --disable-version3',
    '--enable-videotoolbox',
    '--enable-securetransport',
    'FFmpeg config: CONFIG_VIDEOTOOLBOX=1',
    'FFmpeg config: CONFIG_H264_VIDEOTOOLBOX_HWACCEL=1',
    'FFmpeg config: CONFIG_HEVC_VIDEOTOOLBOX_HWACCEL=1',
    'Available hwaccel: videotoolbox',
    'libavcodec VideoToolbox decoders: h264=yes hevc=yes',
    'mpv hwdec policy: auto-copy-safe (software fallback retained)',
  ]) {
    if (!buildInfo.includes(evidence)) throw new Error(`Missing build evidence: ${evidence}`)
  }
  checkMacosDoviEvidence(buildInfo, checkDoviManifest(manifest.macos).artifact)
  const metal = files.includes('libMoltenVK.dylib')
  if (metal) {
    for (const evidence of ['mpv macvk-embedded: enabled', 'mpv videotoolbox-pl: enabled', 'libplacebo Vulkan: enabled; vk-proc-addr: enabled', 'MoltenVK: 1.3.0 (49b97f26ae013b9e5bfb3098ee5dea5e4f58e9e8)', 'glslang: 15.1.0']) {
      if (!buildInfo.includes(evidence)) throw new Error(`Missing Metal build evidence: ${evidence}`)
    }
    for (const name of ['MoltenVK-Apache-2.0.txt', 'glslang-LICENSE.txt', 'SPIRV-Cross-LICENSE.txt', 'SPIRV-Headers-LICENSE.txt', 'SPIRV-Tools-LICENSE.txt', 'Vulkan-Headers-LICENSE.txt', 'Vulkan-Tools-LICENSE.txt', 'cereal-LICENSE.txt', 'Volk-LICENSE.txt']) {
      await fs.access(path.join(directory, 'LICENSES', name))
    }
  }
  const checksumText = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')
  const checksums = new Map(checksumText.trim().split('\n').map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    if (!match || match[2].includes('..') || path.isAbsolute(match[2])) throw new Error('Invalid bundle checksum entry')
    return [match[2], match[1]]
  }))
  const requiredHashes = [...files.filter((name) => name.endsWith('.dylib')), 'BUILD-INFO.txt', ...(metal ? ['SOURCE-OFFER.txt'] : []), ...(await fs.readdir(path.join(directory, 'LICENSES'))).map((name) => `LICENSES/${name}`)]
  for (const name of requiredHashes) {
    if (!checksums.has(name)) throw new Error(`Missing checksum: ${name}`)
  }
  for (const [name, hash] of checksums) {
    const actual = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')
    if (actual !== hash) throw new Error(`Checksum mismatch: ${name}`)
  }
  const dylibs = files.filter((name) => name.endsWith('.dylib'))
  for (const name of dylibs) {
    const library = path.join(directory, name)
    const architectures = run('lipo', ['-archs', library]).trim().split(/\s+/)
    if (!architectures.includes(manifest.macos.architecture)) {
      throw new Error(`${name} does not contain ${manifest.macos.architecture}`)
    }
    const loadCommands = run('otool', ['-L', library])
    if (name === path.basename(manifest.macos.entry) && loadCommands.includes('OpenAL.framework')) {
      throw new Error('libmpv must use CoreAudio; deprecated OpenAL dependency is not allowed')
    }
    for (const line of loadCommands.split('\n').slice(1)) {
      const dependency = line.match(/^\s+(\S+)\s+\(/)?.[1]
      if (!dependency) continue
      if (/^(?:\/private\/tmp|\/opt\/homebrew|\/usr\/local)\//.test(dependency)) {
        throw new Error(`${name} has a non-bundled dependency: ${dependency}`)
      }
      if (dependency.startsWith('@loader_path/')) {
        if (path.basename(dependency) !== dependency.slice('@loader_path/'.length)) throw new Error(`${name} has an escaping loader dependency: ${dependency}`)
        await fs.access(path.join(directory, path.basename(dependency)))
      } else if (!dependency.startsWith('/System/Library/Frameworks/') && !dependency.startsWith('/usr/lib/')) {
        throw new Error(`${name} has an unresolved/non-system dependency: ${dependency}`)
      }
    }
    const buildVersion = run('otool', ['-l', library])
    for (const match of buildVersion.matchAll(/\bminos\s+(\d+)\.(\d+)/g)) {
      const minimum = Number(match[1]) + Number(match[2]) / 100
      const supported = Number.parseFloat(manifest.macos.minimumVersion)
      if (minimum > supported) throw new Error(`${name} requires macOS ${match[1]}.${match[2]}`)
    }
    run('codesign', ['--verify', '--strict', library])
  }
}

console.log(`Verified ${platformName} libmpv bundle for mpv ${manifest.mpvVersion}`)

if ((platformName === 'macos' && process.platform === 'darwin') || (['windows', 'win32'].includes(platformName) && process.platform === 'win32')) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-network-verifier-'))
  try {
    const probe = path.join(temporary, process.platform === 'win32' ? 'network-probe.exe' : 'network-probe')
    run('rustc', ['--edition=2021', fileURLToPath(new URL('./probe-libmpv-network.rs', import.meta.url)), '-o', probe])
    console.log(run(probe, [path.join(directory, process.platform === 'win32' ? 'avformat-62.dll' : 'libavformat.62.dylib')]))
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}
