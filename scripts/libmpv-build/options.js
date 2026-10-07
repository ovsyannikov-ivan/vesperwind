// Pure decisions of `npm run build:libmpv`, kept free of I/O for unit tests.
import path from 'node:path'
import { BuildError } from './common.js'

export const usage = `Usage: npm run build:libmpv [-- --clean] [-- --dry-run] [-- --ci]
  --clean    discard the build cache (downloaded source archives are kept) and build everything
  --dry-run  print the platform, build cache and build mode without building
  --ci       never install software; fail when a prerequisite is missing (implied by CI=true)`

export const parseArguments = (argv) => {
  const options = { clean: false, dryRun: false, ci: false, help: false }
  for (const argument of argv) {
    if (argument === '--clean') options.clean = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--ci') options.ci = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new BuildError(`Unknown option ${argument}\n\n${usage}`)
  }
  return options
}

export const selectPlatform = (platform) => {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  throw new BuildError('Bundled libmpv build is currently supported on macOS and Windows.')
}

const truthy = (value) => value !== undefined && !['', '0', 'false', 'no'].includes(String(value).toLowerCase())

// Local builds may install missing tools (winget, pacman, Homebrew) and open
// the App Store. CI and --ci only check prerequisites and fail deterministically.
export const bootstrapPolicy = (environment, options) => {
  const ci = options.ci || truthy(environment.CI) || truthy(environment.GITHUB_ACTIONS) || truthy(environment.TF_BUILD)
  return { install: !ci, ci }
}

// Stable, platform-specific build caches outside the repository.
export const defaultCacheDirectory = (platform, environment, home) => {
  // ~/Library/Caches/vesperwind is the app's own WebKit cache (case-insensitive).
  if (platform === 'macos') return path.posix.join(home, 'Library', 'Caches', 'vesperwind-build', 'libmpv')
  const local = environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Vesperwind', 'build', 'libmpv')
  return local && usableWindowsBuildPath(local)
    ? local
    : path.win32.join(environment.SystemDrive || 'C:', '\\', 'vesperwind-build', 'libmpv')
}

// MSYS paths, compiler flags and Meson need a short ASCII path without spaces.
export const usableWindowsBuildPath = (directory) => /^[A-Za-z]:\\[\x21-\x7e\\]*$/.test(directory) && directory.length <= 120

export const cacheDirectory = (platform, environment, home, projectRoot) => {
  const override = environment.VESPERWIND_LIBMPV_BUILD_DIR
  const resolve = platform === 'windows' ? path.win32.resolve : path.posix.resolve
  const directory = override ? resolve(override) : defaultCacheDirectory(platform, environment, home)
  if (platform === 'windows' && !usableWindowsBuildPath(directory)) {
    throw new BuildError(`VESPERWIND_LIBMPV_BUILD_DIR must be a short ASCII path without spaces: ${directory}`)
  }
  const paths = platform === 'windows' ? path.win32 : path.posix
  const normal = (value) => platform === 'windows' ? resolve(value).toLowerCase() : resolve(value)
  const relative = paths.relative(normal(projectRoot), normal(directory))
  if (!relative || (!relative.startsWith('..') && !paths.isAbsolute(relative))) {
    throw new BuildError('The libmpv build cache must be outside the repository.')
  }
  return directory
}

// A presentation rebuild (libplacebo + mpv) reuses the cached codec/font
// prefix only when that prefix was completed from the current source pins and
// toolchain and still carries the FFmpeg configuration the bundle requires.
// `clean` discards stages built from other pins or another toolchain; an
// interrupted full build of the same pins and toolchain resumes.
export const chooseBuildMode = (cache, current, { clean = false } = {}) => {
  const full = (reason, discard) => ({ mode: 'full', reason, clean: clean || discard })
  if (clean) return full('--clean was requested', true)
  if (cache.sources !== current.sources) return full(cache.sources ? 'the cache was built from other source pins' : 'no build cache yet', true)
  if (cache.toolchain !== current.toolchain) return full('the cache was built with another toolchain', true)
  if (!cache.complete) return full('the previous full build did not finish', false)
  if (cache.missing.length) return full(`the cache lacks ${cache.missing.join(', ')}`, false)
  return { mode: 'presentation', reason: 'compatible build cache', clean: false }
}

// Build tools the Windows build script and its FFmpeg/Meson/CMake stages call.
// Versions are not pinned here: BUILD-INFO and the manifest record what built
// the artifact.
export const windowsPackages = [
  'make', 'git', 'diffutils', 'curl', 'tar',
  ...['gcc', 'cmake', 'meson', 'ninja', 'pkgconf', 'nasm', 'python', 'shaderc', 'spirv-cross']
    .map((name) => `mingw-w64-ucrt-x86_64-${name}`),
]
export const windowsTools = ['gcc', 'g++', 'cmake', 'meson', 'ninja', 'pkg-config', 'nasm', 'make', 'git', 'curl', 'python', 'cygpath', 'tar']

export const missingPackages = (installedNames, required = windowsPackages) => {
  const installed = new Set(installedNames.split(/\r?\n/).map((line) => line.trim().split(' ')[0]).filter(Boolean))
  return required.filter((name) => !installed.has(name))
}

// Output of the UCRT64 environment check (scripts/libmpv-build/check-ucrt64.sh).
export const parseToolchainReport = (text) => {
  const report = { tools: {}, missing: [], machine: '', msystem: '', toolchain: '' }
  for (const line of text.split(/\r?\n/)) {
    const [kind, name, ...rest] = line.split(' ')
    if (kind === 'tool') report.tools[name] = rest.join(' ')
    else if (kind === 'missing') report.missing.push(name)
    else if (kind === 'machine') report.machine = [name, ...rest].join(' ').trim()
    else if (kind === 'msystem') report.msystem = (name || '').trim()
    else if (kind === 'toolchain') report.toolchain = [name, ...rest].join(' ').trim()
  }
  return report
}

export const toolchainProblem = (report) => {
  if (report.msystem !== 'UCRT64') return `the MSYS2 environment is ${report.msystem || 'unknown'}, not UCRT64`
  if (report.missing.length) return `missing UCRT64 tools: ${report.missing.join(', ')}`
  if (report.machine !== 'x86_64-w64-mingw32') return `gcc targets ${report.machine || 'nothing'}, not x86_64-w64-mingw32`
  return null
}

// C:\a\b → /c/a/b, for arguments handed to MSYS bash without cygpath.
export const msysPath = (windowsPath) => {
  const match = /^([A-Za-z]):[\\/]*(.*)$/.exec(windowsPath)
  if (!match) throw new BuildError(`Not an absolute Windows path: ${windowsPath}`)
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`.replace(/\/$/, '')
}

// MSYS2's curl (pacman, git, source downloads) trusts only its own CA bundle.
// Behind TLS inspection (corporate proxy, antivirus) every mirror then fails
// with curl exit 60 although Windows itself trusts the inspecting root.
export const httpsProbeResult = (results) => {
  if (results.some(({ status }) => status === 0)) return 'ok'
  if (results.some(({ status, stderr = '' }) => status === 60 || /certificate/i.test(stderr))) return 'untrusted-certificate'
  return 'unreachable'
}

// One PEM file for MSYS2's trust anchors from the certificates Windows trusts.
export const pemBundle = (certificates) => [...new Set(certificates.map((pem) => pem.replace(/\r/g, '').trim()))]
  .filter((pem) => /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem))
  .join('\n') + '\n'
