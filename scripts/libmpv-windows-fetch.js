import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const pins = JSON.parse(await fs.readFile(new URL('./libmpv-windows-sources.json', import.meta.url), 'utf8'))
for (const pin of pins) {
  const destination = path.join(process.argv[2], `${pin.name}.tar.gz`)
  try { await fs.access(destination) } catch {
    const result = spawnSync('curl', ['--fail', '--location', '--retry', '3', '--output', destination, pin.url], { stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error(`Download failed: ${pin.name}`)
  }
  const digest = createHash('sha256').update(await fs.readFile(destination)).digest('hex')
  if (digest !== pin.sha256) throw new Error(`Source checksum mismatch: ${pin.name}`)
}
