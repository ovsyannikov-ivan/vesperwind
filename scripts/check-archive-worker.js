import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const archiveWorkerPath = () => {
  const target = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(/^host: (.+)$/m)?.[1]
  if (!target) throw new Error('Unable to determine archive worker target; install the Rust toolchain')
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/binaries', `vesperwind-archive-${target}${process.platform === 'win32' ? '.exe' : ''}`)
}
export const checkArchiveWorker = () => {
  const binary = archiveWorkerPath()
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, shell: false })
  if (result.error || result.status !== 0 || !result.stdout.startsWith('vesperwind-archive/1 libarchive/libarchive 3.8.9 ')) {
    throw new Error('Missing or incompatible bundled archive worker. Run npm run build:archives before dev/build. System archive tools are never used.')
  }
  return binary
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(`Archive worker: ${checkArchiveWorker()}`) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
