import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createPayload, hashFile, magic } from '../scripts/portable-package.mjs'

test('portable payload preserves binary resources and binds the manifest to its compressed contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesper-portable-'))
  try {
    const stage = path.join(root, 'stage'); await fs.mkdir(path.join(stage, 'vendor'), { recursive: true })
    const binary = Buffer.from([0, 255, 3, 0, 42]); const resource = Buffer.alloc(128 * 1024, 37)
    await fs.writeFile(path.join(stage, 'app.exe'), binary)
    await fs.writeFile(path.join(stage, 'vendor', 'asset.bin'), resource)
    const output = path.join(root, 'payload')
    const manifest = await createPayload(stage, output, 'test')
    const payload = await fs.readFile(output)
    assert.equal(await hashFile(output), manifest.sha256)
    assert.deepEqual(payload.subarray(0, magic.length), magic)
    const length = payload.readUInt32LE(magic.length)
    const dataStart = magic.length + 4 + length
    const parsed = JSON.parse(payload.subarray(magic.length + 4, dataStart))
    assert.equal(parsed.version, 'test')
    const inflated = gunzipSync(payload.subarray(dataStart))
    let position = 0
    for (const file of parsed.files) {
      const bytes = inflated.subarray(position, position + file.bytes); position += file.bytes
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
      assert.deepEqual(bytes, await fs.readFile(path.join(stage, file.path)))
    }
    assert.equal(position, inflated.length)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
