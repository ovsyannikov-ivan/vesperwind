import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

if (process.platform === 'darwin') {
  const candidates = [
    path.join(
      process.cwd(),
      'node_modules',
      'node-pty',
      'prebuilds',
      `darwin-${process.arch}`,
      'spawn-helper',
    ),
    path.join(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  ]

  for (const helperPath of candidates) {
    try {
      await fs.access(helperPath)
      await fs.chmod(helperPath, 0o755)
      console.log(`Prepared node-pty helper: ${path.relative(process.cwd(), helperPath)}`)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }
}
