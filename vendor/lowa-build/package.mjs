// Package the four runtime assets only; compiler/build tools stay in scratch.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { brotliCompressSync, constants } from 'node:zlib'
const build = path.resolve(process.argv[2] || ''), output = path.resolve(process.argv[3] || '')
if (!process.argv[2] || !process.argv[3]) throw new Error('Provide completed build directory and a NEW payload directory')
if (fs.existsSync(output)) throw new Error('Do not overwrite another measured payload')
const recipe = JSON.parse(fs.readFileSync(path.join(build, 'recipe.json')))
const candidates = [path.join(build, 'workdir/LinkTarget/Executable'), path.join(build, 'instdir/program')]
const dataRoot = path.join(build, 'workdir/CustomTarget/static/emscripten_fs_image')
const sources = {}
for (const name of ['soffice.js', 'soffice.wasm']) {
  const folder = candidates.find(folder => fs.existsSync(path.join(folder, name)))
  if (!folder) throw new Error('Missing successful final link asset: ' + name)
  sources[name] = path.join(folder, name)
}
for (const name of ['soffice.data', 'soffice.data.js.metadata']) {
  sources[name] = path.join(dataRoot, name)
  if (!fs.existsSync(sources[name])) throw new Error('Missing FS image: ' + name)
}
// A non-zero/partial make cannot be mislabeled as an accepted source payload.
const receipts = fs.readdirSync(build).filter(f => /^build-.*\.json$/.test(f))
  .map(f => JSON.parse(fs.readFileSync(path.join(build, f))))
  .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
if (receipts.at(-1)?.code !== 0) throw new Error('Most recent build receipt is not successful')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
if (receipts.at(-1).recipeSha256 !== hash(JSON.stringify(recipe))) throw new Error('Build receipt belongs to a different recipe')
fs.mkdirSync(output)
const assets = []
for (const [name, source] of Object.entries(sources)) {
  const bytes = fs.readFileSync(source)
  const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 8 } })
  fs.writeFileSync(path.join(output, name), bytes)
  fs.writeFileSync(path.join(output, name + '.br'), br)
  assets.push({ name, bytes: bytes.length, sha256: hash(bytes), brBytes: br.length, brSha256: hash(br) })
  console.log(assets.at(-1))
}
const metadata = JSON.parse(fs.readFileSync(sources['soffice.data.js.metadata']))
const inventory = metadata.files.map(file => ({ name: file.filename, bytes: file.end - file.start }))
if (inventory.some(file => !Number.isFinite(file.bytes) || file.bytes < 0)) throw new Error('Invalid FS image inventory')
const group = pattern => {
  const files = inventory.filter(file => pattern.test(file.name))
  return { files: files.length, bytes: files.reduce((n, file) => n + file.bytes, 0) }
}
const manifest = { schemaVersion: 1, recipe, buildReceipt: receipts.at(-1), assets,
  installedRuntimeBytes: assets.reduce((n, f) => n + f.bytes, 0),
  compressedRuntimeBytes: assets.reduce((n, f) => n + f.brBytes, 0), brotliQuality: 8,
  fsFileCount: metadata.files.length,
  fsGroups: { fonts: group(/\.(ttf|otf)$/i), registry: group(/\.(rdb|xcd)$/i),
    presentationDefaults: group(/config\/soffice\.cfg\/simpress\/(styles|layoutlist|objectlist)\.xml$/),
    gui: group(/config\/soffice\.cfg\/(?!simpress\/(styles|layoutlist|objectlist)\.xml$)|config\/wizard\/|\/intro(-highres)?\.png$|images_.*\.zip$/),
    templatesGallery: group(/\/(template|gallery|autotext)\//),
    scriptsExecutables: group(/\.(py|jar|exe|dylib|dll|so)$/i) },
  notes: ['Raw and Brotli variants coexist here for experiments; installed size is ONE raw set, not their sum.',
    'Stock CDN compression may use a different level; do not treat compressed size as a same-level comparison.',
    'Pins/build success are not a completed bit-identical rebuild or license/SBOM acceptance.'] }
fs.writeFileSync(path.join(output, 'BUILD-INFO.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(output, 'FS-INVENTORY.json'), JSON.stringify(inventory, null, 2) + '\n')
console.log({ installedRuntimeBytes: manifest.installedRuntimeBytes, compressedRuntimeBytes: manifest.compressedRuntimeBytes })
