import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { inspectPe, isSystemDll } from './libmpv-pe.js'
import { verifyWindowsBundle } from './verify-libmpv-windows.js'
import { recordBuiltArtifact } from './libmpv-dovi.js'

const project = fileURLToPath(new URL('../', import.meta.url))
const [work, toolchain] = process.argv.slice(2)
if (!work || !toolchain) throw new Error('Expected build root and UCRT64 root')
const stage = await fs.mkdtemp(path.join(work, 'bundle-'))
const destination = path.join(project, 'src-tauri/vendor/libmpv/windows')
const manifestPath = path.join(project, 'src-tauri/vendor/libmpv/manifest.json')
const manifestText = await fs.readFile(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)
const prefixBin = path.join(work, 'prefix/bin')
const runtimeNames = new Set(['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll', 'libiconv-2.dll'])
const shaderLibraries = new Map([
  ['libshaderc_shared.dll', 'shaderc'],
  ['libspirv-cross-c-shared.dll', 'spirv-cross'],
])
const built = new Map((await fs.readdir(prefixBin)).map((name) => [name.toLowerCase(), path.join(prefixBin, name)]))
// MinGW Meson adds the lib prefix; the application uses one stable entry name.
const entrySource = built.get('mpv-2.dll') ?? built.get('libmpv-2.dll')
if (!entrySource) throw new Error('Missing built libmpv entry DLL')
built.set('mpv-2.dll', entrySource)
const runtime = new Set()
const queue = ['mpv-2.dll']
const copied = new Set()
while (queue.length) {
  const name = queue.shift().toLowerCase()
  if (copied.has(name) || isSystemDll(name)) continue
  let source = built.get(name)
  if (!source && (runtimeNames.has(name) || shaderLibraries.has(name))) {
    source = path.join(toolchain, 'bin', name)
    runtime.add(name)
  }
  if (!source) throw new Error(`Unreviewed/missing runtime dependency: ${name}`)
  const pe = inspectPe(await fs.readFile(source))
  await fs.copyFile(source, path.join(stage, name))
  copied.add(name)
  queue.push(...pe.imports)
}
await fs.mkdir(path.join(stage, 'LICENSES'))
for (const [source, name] of [
  ['mpv/LICENSE.LGPL', 'mpv-LGPL-2.1.txt'], ['mpv/Copyright', 'mpv-Copyright.txt'],
  ['ffmpeg/COPYING.LGPLv2.1', 'FFmpeg-LGPL-2.1.txt'], ['ffmpeg/LICENSE.md', 'FFmpeg-LICENSE.md'],
  ['freetype/LICENSE.TXT', 'FreeType-LICENSE.txt'], ['fribidi/COPYING', 'FriBidi-LGPL-2.1.txt'],
  ['freetype/docs/FTL.TXT', 'FreeType-FTL.txt'],
  ['harfbuzz/COPYING', 'HarfBuzz-COPYING.txt'], ['libass/COPYING', 'libass-ISC.txt'],
  ['libplacebo/LICENSE', 'libplacebo-LGPL-2.1.txt'],
  ['libplacebo/3rdparty/fast_float/LICENSE-MIT', 'fast-float-MIT.txt'],
  ['libplacebo/3rdparty/glad/LICENSE', 'glad-LICENSE.txt'],
]) await fs.copyFile(path.join(work, 'src', source), path.join(stage, 'LICENSES', name))
const licenseDirs = await fs.readdir(path.join(toolchain, 'share/licenses'))
for (const name of runtime) {
  const shaderLicense = shaderLibraries.get(name)
  const pattern = shaderLicense ? new RegExp(`^${shaderLicense}$`) : name.startsWith('libgcc') || name.startsWith('libstdc++') ? /^(gcc|libgcc|libstdc\+\+)$/ :
    name.startsWith('libwinpthread') ? /^(winpthreads|libwinpthread)$/ : /^libiconv$/
  const matches = licenseDirs.filter((directory) => pattern.test(directory))
  if (!matches.length) throw new Error(`Missing toolchain license for ${name}`)
  for (const directory of matches) await fs.cp(path.join(toolchain, 'share/licenses', directory),
    path.join(stage, 'LICENSES', directory), { recursive: true })
}
// shaderc's shared library incorporates these permissively licensed projects.
for (const dependency of ['glslang', 'spirv-tools']) {
  await fs.cp(path.join(toolchain, 'share/licenses', dependency),
    path.join(stage, 'LICENSES', dependency), { recursive: true })
}
const readBuild = async (name) => (await fs.readFile(path.join(work, 'build', name), 'utf8')).trim()
const info = {
  architecture: 'x86_64', minimumWindows: '10', toolchain: await readBuild('toolchain.txt'),
  upstreamEntry: path.basename(entrySource), bundledEntry: 'mpv-2.dll',
  sources: { mpv: manifest.mpvVersion, mpvCommit: manifest.mpvCommit, ...manifest.dependencies },
  archives: JSON.parse(await fs.readFile(new URL('./libmpv-windows-sources.json', import.meta.url), 'utf8')),
  libplaceboSubmodules: await readBuild('libplacebo-submodules.txt'),
  ffmpegFlags: (await readBuild('ffmpeg-flags.txt')).split(/\r?\n/),
  mpvFlags: (await readBuild('mpv-flags.txt')).split(/\r?\n/),
  d3d11va: JSON.parse(await readBuild('d3d11va-probe.json')),
  hardwareDecodePolicy: manifest.windows.hardwareDecodePolicy,
  presentation: manifest.windows.presentation,
  libplaceboOptions: JSON.parse(await fs.readFile(path.join(work, 'build/libplacebo/meson-info/intro-buildoptions.json'), 'utf8'))
    .filter(({ name }) => ['d3d11', 'opengl', 'shaderc', 'dovi', 'libdovi'].includes(name))
    .map(({ name, value }) => `-D${name}=${value}`),
  libplaceboPkgConfig: Object.fromEntries((await readBuild('libplacebo-pkgconfig.txt')).split(/\r?\n/).map((line) => line.split('='))),
  doviMapping: await readBuild('dovi-mapping-probe.txt'),
  runtimeDlls: [...copied].sort(), toolchainPackages: (await readBuild('toolchain-packages.txt')).split(/\r?\n/),
}
await fs.writeFile(path.join(stage, 'BUILD-INFO.txt'), JSON.stringify(info, null, 2) + '\n')
// The manifest describes the checked-in artifact: record what Meson actually
// built (rejecting a build that does not honour the recipe) before verifying.
manifest.windows = recordBuiltArtifact(manifest.windows, info.libplaceboOptions)
// Toolchain packages come from the installed MSYS2; record the ones used.
manifest.windows.buildToolchain = `MSYS2 UCRT64 ${info.toolchain}; application x86_64-pc-windows-msvc`
manifest.windows.shaderToolchainPackages = Object.fromEntries(Object.keys(manifest.windows.shaderToolchainPackages ?? {}).map((name) => {
  const installed = info.toolchainPackages.find((line) => line.startsWith(`${name} `))
  if (!installed) throw new Error(`Missing shader toolchain package: ${name}`)
  return [name, installed.slice(name.length + 1)]
}))
if (!manifest.windows.runtimeValidation?.startsWith('Not validated after this source rebuild')) {
  manifest.windows.runtimeValidation = `Not validated after this source rebuild; repeat docs/build-windows.md acceptance. Previous artifact: ${manifest.windows.runtimeValidation}`
}
await fs.writeFile(path.join(stage, 'SOURCE-OFFER.txt'), `Vesperwind Windows libmpv source and relinking information

Exact upstream source URLs, SHA-256 hashes, revisions, toolchain packages and
configuration flags are in BUILD-INFO.txt and scripts/libmpv-windows-sources.json.
Rebuild with npm run build:libmpv; see docs/build-windows.md.
libplacebo and its submodules are checked out at the recorded Git revisions.
Compiler support libraries are from MSYS2 UCRT64; package sources and build
recipes are available at https://github.com/msys2/MINGW-packages and
https://repo.msys2.org/mingw/sources/ . GCC runtime uses its runtime exception.

For at least three years after distribution, the Vesperwind project offers the
complete corresponding source and build material for no more than the reasonable
cost of physically providing it. Request at:
https://github.com/ovsyannikov-ivan/vesperwind

LGPL libraries remain separate, dynamically linked and replaceable. No technical
measure prevents replacing or relinking them. License texts are in LICENSES/.
`)
const all = (await fs.readdir(stage, { recursive: true })).map((p) => p.replaceAll('\\', '/')).sort()
const sums = []
for (const name of all) {
  const file = path.join(stage, name)
  if ((await fs.stat(file)).isFile()) sums.push(`${createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${name}`)
}
await fs.writeFile(path.join(stage, 'SHA256SUMS'), sums.join('\n') + '\n')
await verifyWindowsBundle(stage, manifest)
await fs.mkdir(destination, { recursive: true })
// Refuse to silently retain stale DLLs from another build.
for (const name of await fs.readdir(destination)) {
  if (/\.dll$/i.test(name) && !copied.has(name.toLowerCase())) throw new Error(`Stale destination DLL: ${name}`)
}
await fs.cp(stage, destination, { recursive: true })
// Replace only the Windows entry; keep the macOS entry and its formatting.
const windowsBlock = /\n  "windows": \{[\s\S]*?\n  \},\n/
if (!windowsBlock.test(manifestText)) throw new Error('Unexpected manifest.json layout')
await fs.writeFile(manifestPath, manifestText.replace(windowsBlock,
  () => `\n  "windows": ${JSON.stringify(manifest.windows, null, 2).replaceAll('\n', '\n  ')},\n`))
await verifyWindowsBundle(destination, JSON.parse(await fs.readFile(manifestPath, 'utf8')))
console.log(`Verified and copied ${copied.size} DLLs to ${destination}`)
