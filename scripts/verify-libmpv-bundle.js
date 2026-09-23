import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

if (platformName === 'macos') {
  if (manifest.macos.hardwareDecode !== true) {
    throw new Error('macOS manifest must record the verified VideoToolbox build')
  }
  const buildInfo = await fs.readFile(path.join(directory, 'BUILD-INFO.txt'), 'utf8')
  for (const evidence of [
    'FFmpeg configuration: --disable-gpl --disable-nonfree --disable-version3 --enable-videotoolbox',
    'FFmpeg config: CONFIG_VIDEOTOOLBOX=1',
    'FFmpeg config: CONFIG_H264_VIDEOTOOLBOX_HWACCEL=1',
    'FFmpeg config: CONFIG_HEVC_VIDEOTOOLBOX_HWACCEL=1',
    'Available hwaccel: videotoolbox',
    'libavcodec VideoToolbox decoders: h264=yes hevc=yes',
    'mpv hwdec policy: auto-copy-safe (software fallback retained)',
  ]) {
    if (!buildInfo.includes(evidence)) throw new Error(`Missing build evidence: ${evidence}`)
  }
  run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: directory })
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
        await fs.access(path.join(directory, path.basename(dependency)))
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
