// Normal builds consume the checked-in payload; they never rebuild LibreOffice.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('../src-tauri/vendor/lowa/', import.meta.url)
const manifest = JSON.parse(await fs.readFile(new URL('ASSETS.json', root), 'utf8'))
for (const entry of manifest.files) {
  const bytes = await fs.readFile(new URL(entry.path, root))
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`Pinned LOWA asset mismatch: ${entry.path}`)
  }
}
console.log(`Verified ${manifest.files.length} pinned LOWA assets (${manifest.profile})`)
