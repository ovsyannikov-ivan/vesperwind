import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// macOS packages always include the thumbnail sidecar. Other platform staging
// is explicit through tauri.ffmpeg.conf.json and its platform build recipe.
if (process.platform === 'darwin') {
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const binary = fileURLToPath(new URL(`../src-tauri/binaries/ffmpeg-${triple}`, import.meta.url))
  const result = existsSync(binary) ? spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 5000 }) : null
  if (!result || result.status !== 0 || !/^ffmpeg version 8\.0(?:-|\s)/.test(result.stdout)) {
    console.error(`Missing/incompatible thumbnail FFmpeg: ${binary}\nBuild the pinned sidecar with: bash scripts/build-thumbnail-ffmpeg.sh`)
    process.exit(1)
  }
  console.log(`Verified thumbnail FFmpeg 8.0 (${triple})`)
}
