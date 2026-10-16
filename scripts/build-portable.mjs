import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createPayload, hashFile, walk } from './portable-package.mjs'
import { inspectPe, isSystemDll } from './libmpv-pe.js'
import { checkArchiveWorker } from './check-archive-worker.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = path.join(root, 'src-tauri/target')
const tools = path.join(target, 'portable-tools')
const stage = path.join(tools, 'stage')
const pins = JSON.parse(await fs.readFile(new URL('./portable-webview2.json', import.meta.url)))
const appConfig = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json')))
// CNG, Cloud Files and network providers are Windows APIs, not redistributable CRTs.
const appSystemDlls = new Set(['bcryptprimitives.dll', 'cldapi.dll', 'mpr.dll'])
const flags = process.argv.slice(2)
let skipAppBuild = false
let outputDirectory = path.join(target, 'release/bundle/portable')
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--skip-app-build') skipAppBuild = true
  else if (flags[i] === '--output-dir' && flags[i + 1] && !flags[i + 1].startsWith('--')) outputDirectory = path.resolve(root, flags[++i])
  else throw Error('Usage: npm run build:portable [-- --skip-app-build] [--output-dir DIRECTORY]')
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Portable builds require Windows x64 with the MSVC Rust toolchain')
if (process.env.CARGO_BUILD_TARGET || process.env.CARGO_TARGET_DIR) throw Error('Use the default Cargo target directory; unset CARGO_BUILD_TARGET and CARGO_TARGET_DIR')

function run(command, args, extra = {}) {
  if (command.toLowerCase() === 'powershell.exe') {
    command = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    extra = { ...extra, env: { ...(extra.env || process.env), PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } }
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...extra })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${command} failed (${result.status ?? result.signal})`)
}
const node = (script, args = [], extra = {}) => run(process.execPath, [path.join(root, script), ...args], extra)
async function cleanGenerated(directory) {
  const absolute = path.resolve(directory)
  if (!absolute.startsWith(`${path.resolve(tools)}${path.sep}`)) throw Error('Refusing to clean outside portable-tools')
  await fs.rm(absolute, { recursive: true, force: true })
}

await fs.mkdir(tools, { recursive: true })
node('scripts/check-native-prereqs.mjs')
try { checkArchiveWorker() } catch { node('scripts/build-archive-worker.js') }
node('scripts/check-lowa-assets.mjs')
node('scripts/verify-libmpv-bundle.js', ['windows'])
const staticEnvironment = { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS || ''} -C target-feature=+crt-static`.trim() }
if (!skipAppBuild) node('scripts/build-tauri.js', ['--no-bundle'], { env: staticEnvironment })

const cab = path.join(tools, `webview2-${pins.version}-x64.cab`)
let cabValid = false
try { cabValid = await hashFile(cab) === pins.sha256 } catch {}
if (!cabValid) {
  console.log(`Downloading pinned WebView2 ${pins.version} from Microsoft`)
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri $env:VESPERWIND_DOWNLOAD_URL -OutFile $env:VESPERWIND_DOWNLOAD_FILE"], {
    env: { ...process.env, VESPERWIND_DOWNLOAD_URL: pins.url, VESPERWIND_DOWNLOAD_FILE: cab },
  })
  if (await hashFile(cab) !== pins.sha256) { await fs.unlink(cab); throw Error('Pinned WebView2 CAB checksum mismatch') }
}
const expanded = path.join(tools, `webview2-${pins.version}-expanded`)
// Re-extract from the pinned CAB on each package build: cached source files are never trusted.
await cleanGenerated(expanded)
await fs.mkdir(expanded)
run(path.join(process.env.SystemRoot, 'System32/expand.exe'), [cab, '-F:*', expanded], { stdio: 'ignore' })
const runtimeExecutables = (await walk(expanded)).filter(file => path.basename(file) === 'msedgewebview2.exe')
if (runtimeExecutables.length !== 1) throw Error('Cannot identify the extracted WebView2 runtime')
const runtime = path.dirname(path.join(expanded, runtimeExecutables[0]))
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:VESPERWIND_RUNTIME_EXE; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 Microsoft signature verification failed' }"], {
  env: { ...process.env, VESPERWIND_RUNTIME_EXE: path.join(runtime, 'msedgewebview2.exe') },
})
await cleanGenerated(stage)
await fs.mkdir(stage)
await fs.copyFile(path.join(target, 'release/vesperwind.exe'), path.join(stage, 'vesperwind.exe'))
await fs.copyFile(checkArchiveWorker(), path.join(stage, 'vesperwind-archive.exe'))
for (const directory of ['vendor/libmpv/windows', 'vendor/lowa']) {
  await fs.cp(path.join(root, 'src-tauri', directory), path.join(stage, directory), { recursive: true, dereference: false })
}
for (const file of ['manifest.json', 'README.md']) await fs.copyFile(path.join(root, 'src-tauri/vendor/libmpv', file), path.join(stage, 'vendor/libmpv', file))
await fs.cp(runtime, path.join(stage, 'vendor/webview2'), { recursive: true, dereference: false })
await fs.mkdir(path.join(stage, 'binaries'))
for (const file of ['libarchive-LICENSE.txt', 'zlib-LICENSE.txt', 'liblzma-LICENSE.txt', 'archive-BUILD-INFO.json']) {
  await fs.copyFile(path.join(root, 'src-tauri/binaries', file), path.join(stage, 'binaries', file))
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, file), path.join(stage, file))
const metadataResult = spawnSync('cargo', ['metadata', '--locked', '--offline', '--filter-platform', 'x86_64-pc-windows-msvc', '--format-version', '1', '--manifest-path', 'native/portable-launcher/Cargo.toml'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
if (metadataResult.status !== 0) throw Error(metadataResult.stderr || 'Cannot read launcher dependency licenses')
const dependencies = JSON.parse(metadataResult.stdout).packages.filter(pkg => pkg.name !== 'vesperwind-portable')
for (const dependency of dependencies) {
  const directory = path.dirname(dependency.manifest_path)
  const notices = (await fs.readdir(directory)).filter(file => /^(LICENSE|COPYING|NOTICE|COPYRIGHT)/i.test(file))
  if (!notices.length) throw Error(`Missing license text for launcher dependency ${dependency.name}`)
  const destination = path.join(stage, 'licenses/portable-launcher', `${dependency.name}-${dependency.version}`)
  await fs.mkdir(destination, { recursive: true })
  for (const file of notices) await fs.cp(path.join(directory, file), path.join(destination, file), { recursive: true })
}
await fs.writeFile(path.join(stage, 'licenses/portable-launcher/dependencies.json'), JSON.stringify(dependencies.map(({ name, version, license, repository }) => ({ name, version, license, repository })), null, 2))
await fs.writeFile(path.join(stage, 'portable.json'), JSON.stringify({ schema: 1 }, null, 2))
await fs.writeFile(path.join(stage, 'BUILD-INFO.json'), JSON.stringify({ schema: 1, version: appConfig.version, architecture: 'x64', webview2: pins, dataDirectory: 'Vesperwind.data beside the outer launcher', builtAt: new Date().toISOString() }, null, 2))
await fs.writeFile(path.join(stage, 'PORTABLE.txt'), 'Launch the outer Vesperwind portable EXE. Settings live in Vesperwind.data beside that EXE.\r\nUse --portable-extract ABSOLUTE_NEW_DIRECTORY to inspect resources and run with replaceable libraries.\r\nExtracted vesperwind.exe recognizes portable.json and uses Vesperwind.data beside itself.\r\nMicrosoft WebView2 Fixed Runtime is redistributed under its accompanying license.\r\nSource versions, licenses and source offers accompany libmpv and LOWA.\r\n')

// Check the application and archive worker independently of DLLs installed on this build host.
for (const name of ['vesperwind.exe', 'vesperwind-archive.exe']) {
  const pe = inspectPe(await fs.readFile(path.join(stage, name)), { requireDll: false })
  const unresolved = pe.imports.filter(dll => !isSystemDll(dll) && !appSystemDlls.has(dll))
  if (unresolved.length) throw Error(`${name} has unbundled imports: ${unresolved.join(', ')}`)
}
const payload = path.join(tools, 'payload.bin')
console.log('Compressing and hashing portable resources')
const manifest = await createPayload(stage, payload, appConfig.version)
await fs.writeFile(path.join(tools, 'manifest.json'), JSON.stringify(manifest, null, 2))
run('cargo', ['build', '--release', '--locked', '--manifest-path', 'native/portable-launcher/Cargo.toml', '--target-dir', 'src-tauri/target'], {
  env: { ...staticEnvironment, VESPERWIND_PORTABLE_PAYLOAD: payload, VESPERWIND_PORTABLE_SHA256: manifest.sha256 },
})
const output = outputDirectory
await fs.mkdir(output, { recursive: true })
const binary = path.join(output, `Vesperwind_${appConfig.version}_windows_x64_portable.exe`)
const pending = path.join(tools, 'verified-portable.exe')
const launcherImports = inspectPe(await fs.readFile(path.join(target, 'release/vesperwind-portable.exe')), { requireDll: false }).imports
const unresolvedLauncher = launcherImports.filter(dll => !isSystemDll(dll) && !appSystemDlls.has(dll))
if (unresolvedLauncher.length) throw Error(`Unbundled launcher dependency: ${unresolvedLauncher.join(', ')}`)
await fs.copyFile(path.join(target, 'release/vesperwind-portable.exe'), pending)
run(pending, ['--portable-verify', '--portable-cache-dir', path.join(tools, 'verification-cache'), '--portable-data-dir', path.join(tools, 'verification-data'), '--portable-report', path.join(tools, 'verification.json')])
await fs.copyFile(pending, binary)
console.log(`Portable EXE: ${binary}\nSHA-256: ${await hashFile(binary)}\nEmbedded files: ${manifest.files.length}`)
