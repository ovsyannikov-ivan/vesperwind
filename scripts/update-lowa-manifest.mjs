// Explicit maintenance step after reviewed payload/wrapper/license changes.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('../src-tauri/vendor/lowa/', import.meta.url)
const entries = (await fs.readdir(root, { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== 'ASSETS.json')
  .map((e) => `${e.parentPath.slice(root.pathname.length)}${e.parentPath.endsWith('/') ? '' : '/'}${e.name}`.replace(/^\//, '')).sort()
const files = []
for (const name of entries) {
  const bytes = await fs.readFile(new URL(name, root))
  files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const bytes = JSON.stringify({ schemaVersion: 1, profile: '128-grow-512', files }, null, 2) + '\n'
await fs.writeFile(new URL('ASSETS.json', root), bytes)
console.log({ files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), buildId: createHash('sha256').update(bytes).digest('hex') })
