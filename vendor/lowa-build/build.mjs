// Source build controller; no runtime executable conversion or app integration.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { buildDirectory } from './prepare.mjs'

const scratch = fs.realpathSync(process.env.LOWA_SCRATCH || '/private/tmp/vesperwind-lowa-rebuild')
const curated = process.env.LOWA_TRIM_PACKAGE === '1'
const build = buildDirectory(scratch, curated, process.env.LOWA_BUILD_DIRECTORY)
const recipe = JSON.parse(fs.readFileSync(path.join(build, 'recipe.json'), 'utf8'))
const stage = process.argv[2]
if (!['configure', 'build'].includes(stage)) throw new Error('Use configure or build')
const jobs = Number(process.env.LOWA_JOBS || 4)
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('Bound jobs to 1..8')
const env = {
  ...process.env,
  ...recipe.configureEnv,
  PATH: [path.join(scratch, 'tools/bin'), path.join(scratch, 'node-v20.14.0-darwin-arm64/bin'),
    path.join(scratch, 'emsdk/upstream/emscripten'), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
  EMSDK: path.join(scratch, 'emsdk'), EM_CONFIG: path.join(scratch, 'emscripten.config'),
  PYTHON: process.env.LOWA_BUILD_PYTHON || '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
  MAKE: path.join(scratch, 'tools/bin/make'),
  SOURCE_DATE_EPOCH: '1746085519',
}
const executable = stage === 'configure' ? '/usr/bin/perl' : env.MAKE
const args = stage === 'configure' ? [path.join(recipe.source, 'autogen.sh')] : ['-j' + jobs, 'build']
if (stage === 'build') {
  const configuration = fs.readFileSync(path.join(build, 'config_host.mk'), 'utf8')
  if (!/^export GIT_NEEDED_SUBMODULES=\s*$/m.test(configuration)) {
    throw new Error('Archive build needs explicit pins for enabled submodules; do not download unversioned submodule tarballs')
  }
  // GitHub source snapshots lack the release tarball's sources.ver. Use the
  // actual configured version; no dictionary/help/translation submodule is used.
  const component = name => configuration.match(new RegExp(`^export LIBO_VERSION_${name}=(\\d+)$`, 'm'))?.[1]
  const version = ['MAJOR', 'MINOR', 'MICRO', 'PATCH'].map(component)
  if (version.some(v => v === undefined)) throw new Error('Missing configured source version')
  fs.writeFileSync(path.join(recipe.source, 'sources.ver'),
    `# Vesperwind pinned GitHub snapshot ${recipe.coreCommit}; all submodules disabled.\nlo_sources_ver=${version.join('.')}\n`)
}
const startedAt = new Date().toISOString()
const recipeSha256 = createHash('sha256').update(JSON.stringify(recipe)).digest('hex')
const host = { platform: os.platform(), architecture: os.arch(), release: os.release(),
  node: process.version, python: execFileSync(env.PYTHON, ['--version'], { encoding: 'utf8' }).trim(),
  xcode: execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim() }
const logName = `${stage}-${recipe.profileName}-${Date.now()}`
let relink = null
if (process.env.LOWA_FORCE_RELINK === '1') {
  if (stage !== 'build') throw new Error('Relinking is a build stage, not a reconfigure')
  const previous = fs.readdirSync(build).filter(file => /^build-.*\.json$/.test(file))
    .map(file => JSON.parse(fs.readFileSync(path.join(build, file))))
    .filter(receipt => receipt.code === 0)
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1)
  if (previous?.code !== 0 || !previous.recipe) throw new Error('Relink requires a completed recipe-recorded build')
  const compileRecipe = value => ({ coreCommit: value.coreCommit, compilerCommit: value.compilerCommit,
    trim: value.trim, options: value.options, configureEnv: value.configureEnv,
    changes: value.changes.filter(change => change.relative !== 'solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk') })
  if (JSON.stringify(compileRecipe(previous.recipe)) !== JSON.stringify(compileRecipe(recipe))) {
    throw new Error('Only the recorded linker memory profile may change during object reuse')
  }
  if (createHash('sha256').update(fs.readFileSync(path.join(build, 'config_host.mk'))).digest('hex') !== previous.configurationSha256) {
    throw new Error('Object reuse requires unchanged compiler/configuration inputs')
  }
  const executable = ['workdir/LinkTarget/Executable/soffice.js', 'instdir/program/soffice.js']
    .map(relative => path.join(build, relative)).find(file => fs.existsSync(file))
  if (!executable) throw new Error('Relink requires the previous final JS target')
  const backup = path.join(build, logName + '-previous-soffice.js')
  // Moving only this owned final target forces the ordinary dependency-checked
  // make build to relink. Previously packaged payloads remain immutable.
  relink = { previousBuildLog: previous.log, previousProfile: previous.recipe.profileName,
    previousJsSha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    target: executable, backup }
  fs.renameSync(executable, backup)
}
const log = fs.openSync(path.join(build, logName + '.log'), 'w')
console.log({ stage, executable, args, build, profile: recipe.profileName, startedAt, log: logName })
const child = spawn(executable, args, { cwd: build, env, stdio: ['ignore', log, log] })
const result = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => resolve({ code, signal }))
})
fs.closeSync(log)
const receipt = { schemaVersion: 1, stage, startedAt, finishedAt: new Date().toISOString(),
  ...result, recipeSha256, recipe, host,
  relink,
  configurationSha256: fs.existsSync(path.join(build, 'config_host.mk'))
    ? createHash('sha256').update(fs.readFileSync(path.join(build, 'config_host.mk'))).digest('hex') : null,
  jobs, log: logName + '.log', coreCommit: recipe.coreCommit, compilerCommit: recipe.compilerCommit }
fs.writeFileSync(path.join(build, logName + '.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log({ ...receipt, recipe: '(saved in receipt)', host: '(saved in receipt)' })
if (result.code !== 0) process.exitCode = 1
