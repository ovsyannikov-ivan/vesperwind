// Build-time only. No SDK/tool executable is included in the runtime payload.
// macOS arm64 bootstrap; Windows runs the resulting portable WASM, not this SDK.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const pins = JSON.parse(fs.readFileSync(new URL('./sources.lock.json', import.meta.url), 'utf8'))
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This pinned SDK is macOS arm64 only')
const scratch = path.resolve(process.env.LOWA_SCRATCH || '/private/tmp/vesperwind-lowa-rebuild')
if (/\s/.test(fs.realpathSync(scratch))) throw new Error('Use a space-free real scratch mount/path')
if (fs.existsSync(path.join(scratch, 'core-' + pins.core.commit))) {
  throw new Error('Bootstrap requires a fresh scratch directory; use prepare/build to resume an existing tree')
}
const jobs = Number(process.env.LOWA_JOBS || 4)
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('Bound jobs to 1..8')
const archiveDir = path.resolve(process.env.LOWA_ARCHIVES || scratch)
fs.mkdirSync(archiveDir, { recursive: true })
const env = { ...process.env, PATH: `${scratch}/tools/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  SOURCE_DATE_EPOCH: String(pins.core.sourceDateEpoch) }
const run = async (executable, args, cwd, label) => {
  const file = fs.openSync(path.join(scratch, label + '.log'), 'w')
  console.log({ label, executable, args, cwd })
  try {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', file, file] })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    if (code !== 0) throw new Error(`${label} failed (${code}); inspect its log`)
  } finally { fs.closeSync(file) }
}
const hashFile = async file => {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const archive = async (pin, name) => {
  const file = path.join(archiveDir, name)
  if (!fs.existsSync(file)) {
    await run('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30',
      '--max-time', '1800', '--proto', '=https', '--proto-redir', '=https', '-o', file + '.partial', pin.url], scratch, 'fetch-' + name)
    fs.renameSync(file + '.partial', file)
  }
  if (await hashFile(file) !== pin.sha256) throw new Error('Checksum mismatch: ' + name)
  return file
}
const extract = async (file, destination, strip = 0) => {
  fs.mkdirSync(destination, { recursive: true })
  await run('/usr/bin/tar', ['-xf', file, '-C', destination, ...(strip ? ['--strip-components', String(strip)] : [])],
    scratch, 'extract-' + path.basename(destination))
}
const core = await archive(pins.core, 'core-efaf067.tar.gz')
const compiler = await archive(pins.emscripten, 'emscripten-949ee1d.tar.gz')
const sdk = await archive(pins.sdk, 'wasm-binaries-3.1.65-arm64.tar.xz')
await extract(core, path.join(scratch, 'core-' + pins.core.commit), 1)
await extract(compiler, path.join(scratch, 'emsdk/upstream/emscripten'), 1)
await extract(sdk, path.join(scratch, 'sdk'))
const link = (target, name) => {
  if (fs.existsSync(name)) {
    if (!fs.lstatSync(name).isSymbolicLink() || fs.realpathSync(name) !== fs.realpathSync(target)) {
      throw new Error('Unexpected existing toolchain path: ' + name)
    }
  } else fs.symlinkSync(target, name, 'dir')
}
fs.mkdirSync(path.join(scratch, 'emscripten-cache'), { recursive: true })
for (const name of ['bin', 'lib']) link(path.join(scratch, 'sdk/install', name), path.join(scratch, 'emsdk/upstream', name))
link(path.join(scratch, 'emscripten-cache'), path.join(scratch, 'emsdk/upstream/emscripten/cache'))
// m4 precedes autoconf; no reliance on a Homebrew keg or changing system tools.
for (const pin of pins.buildTools) {
  const file = await archive(pin, new URL(pin.url).pathname.split('/').at(-1))
  const directory = path.join(scratch, `${pin.name === 'node' ? 'node-v' : pin.name + '-'}${pin.version}${pin.name === 'node' ? '-darwin-arm64' : ''}`)
  await extract(file, directory, 1)
  if (pin.name === 'node') continue
  await run(path.join(directory, 'configure'), ['--prefix=' + path.join(scratch, 'tools')], directory, pin.name + '-configure')
  const make = fs.existsSync(path.join(scratch, 'tools/bin/make')) ? path.join(scratch, 'tools/bin/make') : '/usr/bin/make'
  await run(make, ['-j' + jobs], directory, pin.name + '-build')
  await run(make, ['install'], directory, pin.name + '-install')
}
env.PATH = `${scratch}/node-v20.14.0-darwin-arm64/bin:${env.PATH}`
await run(path.join(scratch, 'node-v20.14.0-darwin-arm64/bin/npm'),
  ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
  path.join(scratch, 'emsdk/upstream/emscripten'), 'emscripten-npm-ci')
console.log('Bootstrap complete. Run prepare.mjs, build.mjs configure, then build.mjs build.')
