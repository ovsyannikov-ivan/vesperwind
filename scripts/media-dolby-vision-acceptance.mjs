// Opens one local Dolby Vision file in the real application through the
// --media-ui-regression driver and records the player's structured Dolby
// Vision diagnostics, the rendered Info panel and the player's log line.
// Copyrighted samples stay outside the repository; pass their paths.
// Usage: node scripts/media-dolby-vision-acceptance.mjs /absolute/movie.mkv [output-dir]
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const video = process.argv[2]
if (!video || !path.isAbsolute(video)) throw Error('Pass an absolute path to a local video')
const output = process.argv[3] || `/private/tmp/vesperwind-dolby-vision-${randomUUID()}`
await fs.mkdir(output, { recursive: true })
const queues = new Map(), pending = new Map(), ready = new Set()
const token = randomUUID(); let sequence = 0
const server = createServer(async (request, response) => {
  const route = (request.url || '').slice(token.length + 2)
  if (!(request.url || '').startsWith(`/${token}/`)) { response.writeHead(404).end(); return }
  const origin = request.headers.origin
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
  response.setHeader('Content-Type', 'application/json')
  if (request.method === 'GET' && route.startsWith('next/')) {
    response.end(JSON.stringify(queues.get(route.slice(5))?.shift() || null)); return
  }
  let body = ''; for await (const chunk of request) body += chunk
  const value = JSON.parse(body || '{}')
  if (route === 'ready') ready.add(value.label)
  else if (route === 'result') {
    const job = pending.get(value.id)
    if (job) { clearTimeout(job.timer); pending.delete(value.id); value.error ? job.reject(Error(value.error)) : job.resolve(value.result) }
  }
  response.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = path.join(output, 'config.json')
await fs.writeFile(config, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/${token}`, profile: output,
  allowHiddenFrames: process.env.VESPERWIND_MEDIA_ALLOW_HIDDEN_FRAMES === '1' }))
const logPath = path.join(output, 'app.log')
const log = await fs.open(logPath, 'w')
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.join(repo, 'src-tauri/target/debug/bundle/macos/Vesperwind.app/Contents/MacOS/vesperwind')
const child = spawn(binary, ['--media-ui-regression', config], { cwd: repo, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, FILE_MANAGER_ROOT: '/', VESPERWIND_SETTINGS_PATH: path.join(output, 'settings.json') } })
const wait = async (check, timeout = 60000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw Error('Timed out waiting for native UI')
}
const command = (label, action, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native ${label}/${action} timed out`)) }, 90000)
  pending.set(id, { resolve, reject, timer }); const queue = queues.get(label) || []
  queue.push({ id, action, args }); queues.set(label, queue)
})
try {
  await wait(() => ready.has('main'))
  await command('main', 'navigate', { path: path.dirname(video), side: 'left' })
  await command('main', 'open', { path: video })
  await wait(() => ready.has('media-overlay'))
  const info = await command('media-overlay', 'videoInfo')
  const lines = (await fs.readFile(logPath, 'utf8')).split('\n').filter(line => line.includes('dolby-vision '))
  const result = { video, dolbyVision: info.diagnostics.dolbyVision, renderer: info.diagnostics.renderer,
    currentVo: info.diagnostics.currentVo, hardwareDecoder: info.diagnostics.hardwareDecoder,
    matrix: info.diagnostics.video?.matrix, outputMode: info.diagnostics.outputMode,
    systemDolbyVisionOutput: info.diagnostics.systemDolbyVisionOutput, info: info.sections, log: lines }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  void command('main', 'quit').catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 2000)); child.kill('SIGTERM')
  for (const job of pending.values()) clearTimeout(job.timer)
  server.closeAllConnections(); server.close(); await log.close()
}
