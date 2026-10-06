// macOS backend of `npm run build:libmpv`: resolves Xcode and the build tools
// the source build needs, then runs the internal scripts/build-libmpv-macos.sh,
// which downloads the pinned sources, builds the arm64 bundle (mpv, FFmpeg,
// libplacebo with dovi, MoltenVK/Vulkan, glslang, VideoToolbox) and records
// its evidence.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BuildError, exists, findOnPath, log, projectRoot, requireFreeSpace, run } from './common.js'

// Prefer an explicit DEVELOPER_DIR, then xcode-select, then any installed
// Xcode.app; the Command Line Tools alone have no VideoToolbox-capable SDK.
export const resolveDeveloperDirectory = ({ environment = process.env,
  selected = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout?.trim(),
  applications = (() => { try { return fs.readdirSync('/Applications') } catch { return [] } })() } = {}) => {
  const candidates = [environment.DEVELOPER_DIR, selected,
    ...applications.filter((name) => /^Xcode.*\.app$/.test(name)).sort().map((name) => `/Applications/${name}/Contents/Developer`)]
  return candidates.find((candidate) => candidate && exists(path.join(candidate, 'usr/bin/xcodebuild'))) || null
}

// Compiler and linker flags cannot contain whitespace; route a cache path with
// spaces through a stable symlink.
export const spacelessDirectory = (directory) => {
  if (!/\s/.test(directory)) return directory
  fs.mkdirSync(directory, { recursive: true })
  const link = `/private/tmp/vesperwind-libmpv-build-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`
  try { fs.unlinkSync(link) } catch {}
  fs.symlinkSync(directory, link)
  return link
}

const requireXcode = (policy) => {
  const developerDirectory = resolveDeveloperDirectory()
  if (!developerDirectory) {
    if (policy.install) spawnSync('open', ['macappstore://apps.apple.com/app/xcode/id497799835'])
    throw new BuildError(`Xcode is required (the Command Line Tools alone lack the VideoToolbox SDK).${policy.install ? ' The App Store page for Xcode has been opened.' : ''}\n\nInstall Xcode, open it once, and rerun:\n\n  npm run build:libmpv`)
  }
  const version = spawnSync(path.join(developerDirectory, 'usr/bin/xcodebuild'), ['-version'],
    { encoding: 'utf8', env: { ...process.env, DEVELOPER_DIR: developerDirectory } })
  if (version.status !== 0) {
    const reason = /license/i.test(version.stderr || '') ? 'its license has not been accepted' : 'it has not finished its first launch'
    throw new BuildError(`Xcode at ${developerDirectory} cannot build yet: ${reason}.\n\nOpen Xcode once (or run: sudo xcodebuild -license accept) and rerun:\n\n  npm run build:libmpv`)
  }
  return developerDirectory
}

const ensureBuildTools = async (policy) => {
  const missing = ['cmake', 'pkg-config'].filter((tool) => !findOnPath(tool))
  if (!missing.length) return
  const brew = findOnPath('brew', ['/opt/homebrew/bin', '/usr/local/bin'])
  if (!policy.install) throw new BuildError(`Missing build tools, and CI builds do not install software: ${missing.join(', ')}`)
  if (!brew) {
    throw new BuildError(`The libmpv build needs ${missing.join(' and ')}. Install Homebrew from https://brew.sh and rerun:\n\n  npm run build:libmpv\n\nThe tools themselves are then installed automatically.`)
  }
  log(`Installing ${missing.join(', ')} with Homebrew`)
  await run(brew, ['install', ...missing], { failure: `brew install ${missing.join(' ')} failed` })
  process.env.PATH = [path.dirname(brew), process.env.PATH].join(path.delimiter)
}

export const build = async ({ cache, options, policy }) => {
  if (process.arch !== 'arm64') throw new BuildError('The bundled macOS libmpv is built for Apple silicon (arm64) only.')
  const developerDirectory = requireXcode(policy)
  // The macOS recipe always rebuilds every stage from the cached archives.
  const plan = { platform: 'macos', developerDirectory, cache, mode: 'full', reason: 'the macOS build always rebuilds all stages', clean: options.clean }
  if (options.dryRun) return plan
  await ensureBuildTools(policy)
  if (options.clean && exists(cache)) {
    for (const name of fs.readdirSync(cache)) if (name !== 'archives') fs.rmSync(path.join(cache, name), { recursive: true, force: true })
  }
  fs.mkdirSync(cache, { recursive: true })
  requireFreeSpace(cache, 8)
  log(`Xcode: ${developerDirectory}`)
  log(`Build cache: ${cache}`)
  log('Building the macOS libmpv bundle from pinned sources.')
  await run('bash', [path.join(projectRoot, 'scripts/build-libmpv-macos.sh')], {
    cwd: projectRoot,
    env: { ...process.env, DEVELOPER_DIR: developerDirectory, VESPERWIND_LIBMPV_BUILD_DIR: spacelessDirectory(cache) },
    failure: `The macOS libmpv build failed; the output above shows the failing step (build cache: ${cache}). Rerun npm run build:libmpv after fixing it.`,
  })
  return plan
}
