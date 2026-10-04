// Explicit test discovery prevents MPEG-TS fixture segments (*.ts) from being
// interpreted as TypeScript tests by recent Node versions. Discover recursively.
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
const files = (await fs.readdir('test', { recursive: true })).filter((file) => /\.test\.(?:[cm]?js|[cm]?ts)$/.test(file)).sort().map((file) => `test/${file}`)
const processResult = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
processResult.on('error', (error) => { console.error(error); process.exitCode = 1 })
processResult.on('exit', (code) => { process.exitCode = code ?? 1 })
