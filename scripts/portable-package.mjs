import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const magic = Buffer.from('VESPERWIND-P1\n')
export const hashFile = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function walk(directory, relative = '') {
  const files = []
  for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw Error(`Cannot package a symbolic link: ${name}`)
    if (entry.isDirectory()) files.push(...await walk(directory, name))
    else if (entry.isFile()) files.push(name)
    else throw Error(`Unsupported package entry: ${name}`)
  }
  return files
}
export async function createPayload(directory, output, version) {
  const files = []
  for (const file of await walk(directory)) {
    const absolute = path.join(directory, file)
    files.push({ path: file, bytes: (await fs.stat(absolute)).size, sha256: await hashFile(absolute) })
  }
  const manifest = { schema: 1, version, files }
  const json = Buffer.from(JSON.stringify(manifest))
  const size = Buffer.alloc(4); size.writeUInt32LE(json.length)
  await fs.writeFile(output, Buffer.concat([magic, size, json]))
  async function* contents() {
    for (const file of files) yield* createReadStream(path.join(directory, file.path))
  }
  await pipeline(Readable.from(contents()), createGzip({ level: 6 }), createWriteStream(output, { flags: 'a' }))
  return { ...manifest, sha256: await hashFile(output) }
}
