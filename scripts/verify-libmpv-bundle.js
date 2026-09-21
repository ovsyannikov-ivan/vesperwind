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
for (const required of ['LICENSES', 'SOURCE-OFFER.txt', 'SHA256SUMS']) {
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
  run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: directory })
  const dylibs = files.filter((name) => name.endsWith('.dylib'))
  for (const name of dylibs) {
    const library = path.join(directory, name)
    const architectures = run('lipo', ['-archs', library]).trim().split(/\s+/)
    if (!architectures.includes(manifest.macos.architecture)) {
      throw new Error(`${name} does not contain ${manifest.macos.architecture}`)
    }
    const loadCommands = run('otool', ['-L', library])
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
