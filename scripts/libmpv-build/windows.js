// Windows backend of `npm run build:libmpv`: finds or installs MSYS2,
// installs the UCRT64 build tools with pacman, checks the environment, picks a
// full or presentation-only (libplacebo + mpv) rebuild and runs the internal
// scripts/build-libmpv-windows.sh in UCRT64. Packaging records the evidence.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BuildError, exists, findOnPath, jobs, log, projectRoot, requireFreeSpace, run } from './common.js'
import { chooseBuildMode, missingPackages, msysPath, parseToolchainReport, toolchainProblem } from './options.js'

export const sourcesHash = () => createHash('sha256')
  .update(fs.readFileSync(path.join(projectRoot, 'scripts/libmpv-windows-sources.json')))
  .digest('hex')

const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }

const prefixPackages = ['libavcodec', 'libavutil', 'freetype2', 'fribidi', 'harfbuzz', 'libass']
const ffmpegEvidence = [
  ['config.h', '#define CONFIG_SCHANNEL 1'],
  ['config_components.h', '#define CONFIG_HTTPS_PROTOCOL 1'],
  ['config_components.h', '#define CONFIG_HLS_DEMUXER 1'],
  ['config.h', '#define CONFIG_D3D11VA 1'],
  ['config_components.h', '#define CONFIG_H264_D3D11VA_HWACCEL 1'],
  ['config_components.h', '#define CONFIG_HEVC_D3D11VA_HWACCEL 1'],
]

// Stamps written by build-libmpv-windows.sh: the source pins and toolchain a
// full build started with, and prefix-complete once its codec/font prefix
// finished. The rest is evidence the cached prefix must still carry.
export const readCacheState = (cache) => {
  const missing = []
  for (const name of prefixPackages) if (!exists(path.join(cache, 'prefix/lib/pkgconfig', `${name}.pc`))) missing.push(`${name}.pc`)
  for (const [file, line] of ffmpegEvidence) {
    if (!read(path.join(cache, 'build/ffmpeg', file))?.split(/\r?\n/).includes(line)) missing.push(line.slice(15))
  }
  if (!read(path.join(cache, 'build/ffmpeg-flags.txt'))?.includes('--enable-schannel')) missing.push('Schannel FFmpeg flags')
  if (!exists(path.join(cache, 'build/d3d11va-probe.json'))) missing.push('D3D11VA probe')
  return {
    sources: read(path.join(cache, 'cache-sources.sha256'))?.trim() || null,
    toolchain: read(path.join(cache, 'cache-toolchain.txt'))?.trim() || null,
    complete: exists(path.join(cache, 'prefix-complete')),
    missing,
  }
}

const registryInstallLocations = () => {
  const locations = []
  for (const hive of ['HKCU', 'HKLM']) {
    const result = spawnSync('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/v', 'InstallLocation'], { encoding: 'utf8' })
    for (const match of (result.stdout || '').matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) {
      if (/msys/i.test(match[1])) locations.push(match[1].trim())
    }
  }
  return locations
}

export const msysCandidates = (environment = process.env, registry = registryInstallLocations, shell = findOnPath('msys2_shell.cmd')) => {
  const drive = environment.SystemDrive || 'C:'
  return [environment.MSYS2_ROOT, `${drive}\\msys64`, 'C:\\msys64', 'C:\\tools\\msys64',
    environment.USERPROFILE && `${environment.USERPROFILE}\\scoop\\apps\\msys2\\current`,
    environment.LOCALAPPDATA && `${environment.LOCALAPPDATA}\\msys64`,
    shell && path.win32.dirname(shell), ...registry()].filter(Boolean)
}

const isMsysRoot = (root) => ['usr\\bin\\bash.exe', 'usr\\bin\\pacman.exe'].every((file) => exists(path.win32.join(root, file)))

export const findMsys = () => msysCandidates().find(isMsysRoot) || null

const officialInstall = 'Install MSYS2 with the official installer from https://www.msys2.org (default folder C:\\msys64) and rerun:\n\n  npm run build:libmpv'

const installMsys = async (policy) => {
  if (!policy.install) throw new BuildError(`MSYS2 is not installed, and CI builds do not install software.\n\n${officialInstall}`)
  const winget = findOnPath('winget')
  if (!winget) throw new BuildError(`Unable to install MSYS2 automatically because winget is unavailable.\n\n${officialInstall}`)
  log('MSYS2 is not installed. Installing it with winget (Windows may ask for permission).')
  // winget reports some benign states with non-zero codes; finding MSYS2
  // afterwards is what counts.
  await run(winget, ['install', '--id', 'MSYS2.MSYS2', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements']).catch(() => {})
  const root = findMsys()
  if (!root) throw new BuildError(`winget did not install MSYS2.\n\n${officialInstall}`)
  return root
}

// UCRT64 is entered through its environment variables and a script file, not
// through a login shell running a nested quoted command.
const ucrt64Environment = (root, extra = {}) => {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') || 'PATH'
  return {
    ...process.env, ...extra, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1', MSYS2_PATH_TYPE: 'minimal',
    [key]: [path.win32.join(root, 'ucrt64', 'bin'), path.win32.join(root, 'usr', 'bin'), process.env[key]].filter(Boolean).join(';'),
  }
}
const msysTool = (root, name) => path.win32.join(root, 'usr', 'bin', `${name}.exe`)
const pacman = (root, args, failure) => run(msysTool(root, 'pacman'), args, { env: ucrt64Environment(root), failure })
const installedPackages = (root) => spawnSync(msysTool(root, 'pacman'), ['-Qq'], { encoding: 'utf8', env: ucrt64Environment(root) }).stdout || ''

const provisionPackages = async (root, policy) => {
  // A fresh MSYS2 completes its first-run setup (home, pacman keyring) in its
  // first login shell.
  await run(msysTool(root, 'bash'), ['--login', '-c', 'exit 0'],
    { env: ucrt64Environment(root), failure: 'MSYS2 could not complete its first start.' })
  const missing = missingPackages(installedPackages(root))
  if (!missing.length) return
  if (!policy.install) throw new BuildError(`MSYS2 lacks build packages, and CI builds do not install software: ${missing.join(' ')}`)
  log(`Installing MSYS2 build packages: ${missing.join(' ')}`)
  // Synchronise first so new packages match the installed runtime. A core
  // update ends the first pass early; the second completes it.
  await pacman(root, ['-Syuu', '--noconfirm', '--disable-download-timeout']).catch(() => {})
  await pacman(root, ['-Syuu', '--noconfirm', '--disable-download-timeout'], 'Updating MSYS2 with pacman failed; check the network connection and rerun npm run build:libmpv.')
  await pacman(root, ['-S', '--needed', '--noconfirm', '--disable-download-timeout', ...missing], `pacman could not install: ${missing.join(' ')}`)
  const still = missingPackages(installedPackages(root))
  if (still.length) throw new BuildError(`MSYS2 packages are still missing after installation: ${still.join(' ')}`)
}

const checkToolchain = (root, cache) => {
  const result = spawnSync(msysTool(root, 'bash'), [msysPath(path.join(projectRoot, 'scripts', 'libmpv-build', 'check-ucrt64.sh'))],
    { encoding: 'utf8', cwd: cache, env: ucrt64Environment(root) })
  if (result.error) throw new BuildError(`MSYS2 bash could not start: ${result.error.message}`)
  const report = parseToolchainReport(result.stdout || '')
  const problem = toolchainProblem(report)
  if (problem) throw new BuildError(`The MSYS2 UCRT64 build environment is not usable: ${problem}.`)
  return report
}

// Downloaded archives stay (their hashes are checked again before use).
export const cleanCache = (cache) => {
  if (!exists(cache)) return
  for (const name of fs.readdirSync(cache)) {
    if (name !== 'archives') fs.rmSync(path.join(cache, name), { recursive: true, force: true })
  }
}

export const build = async ({ cache, options, policy }) => {
  if (options.dryRun) {
    // Without MSYS2 the current toolchain is unknown; assume it is unchanged.
    const state = readCacheState(cache)
    return { platform: 'windows', msys: findMsys(), cache, ...chooseBuildMode(state, { sources: sourcesHash(), toolchain: state.toolchain }, options) }
  }
  const root = findMsys() || await installMsys(policy)
  log(`MSYS2: ${root}`)
  await provisionPackages(root, policy)
  fs.mkdirSync(cache, { recursive: true })
  const report = checkToolchain(root, cache)
  const current = { sources: sourcesHash(), toolchain: report.toolchain }
  const choice = chooseBuildMode(readCacheState(cache), current, options)
  if (choice.clean) cleanCache(cache)
  fs.mkdirSync(cache, { recursive: true })
  requireFreeSpace(cache, choice.mode === 'full' ? 15 : 5)
  log(`Build cache: ${cache}`)
  log(choice.mode === 'presentation'
    ? 'Existing compatible build cache found. Rebuilding libplacebo + mpv only.'
    : `No compatible build cache found (${choice.reason}). Performing full libmpv build.`)
  // Bash reads scripts incrementally; run a snapshot so repository edits during
  // a long build cannot change its remaining commands.
  const snapshot = path.join(cache, 'build-libmpv-windows.sh')
  fs.copyFileSync(path.join(projectRoot, 'scripts/build-libmpv-windows.sh'), snapshot)
  await run(msysTool(root, 'bash'), [msysPath(snapshot)], {
    cwd: projectRoot,
    env: ucrt64Environment(root, {
      VESPERWIND_NODE: process.execPath,
      VESPERWIND_LIBMPV_BUILD_DIR: cache,
      VESPERWIND_LIBMPV_PROJECT: projectRoot,
      VESPERWIND_LIBMPV_JOBS: jobs(),
      VESPERWIND_LIBMPV_PRESENTATION_ONLY: choice.mode === 'presentation' ? '1' : '0',
      VESPERWIND_LIBMPV_SOURCES_SHA256: current.sources,
      VESPERWIND_LIBMPV_TOOLCHAIN: current.toolchain,
    }),
    failure: `The Windows libmpv build failed; the output above shows the failing step (build cache: ${cache}). Rerun npm run build:libmpv after fixing it, or npm run build:libmpv -- --clean to start over.`,
  })
  return { platform: 'windows', msys: root, cache, ...choice }
}
