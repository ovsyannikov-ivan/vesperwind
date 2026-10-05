import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2] || `/private/tmp/vesperwind-media-acceptance-${randomUUID()}`
await fs.mkdir(output, { recursive: false })
const files = path.join(output, 'files'); await fs.mkdir(files)
const ffmpeg = path.join(repo, `src-tauri/binaries/ffmpeg-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`)
execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=90',
  '-c:v', 'mpeg4', '-q:v', '6', '-threads', '1', '-pix_fmt', 'yuv420p', path.join(files, 'media-smoke.mp4')], { stdio: 'ignore', timeout: 60000 })
await fs.copyFile(path.join(repo, 'test/fixtures/media/long.m4b'), path.join(files, 'book.m4b'))
const traces = [], results = [], queues = new Map(), pending = new Map(), ready = new Set()
const token = randomUUID(); let sequence = 0
const server = createServer(async (request, response) => {
  const url = request.url || ''
  if (!url.startsWith(`/${token}/`)) { response.writeHead(404).end(); return }
  const route = url.slice(token.length + 2)
  const origin = request.headers.origin
  if (origin && !['http://127.0.0.1:1420', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'null'].includes(origin)) { response.writeHead(403).end(); return }
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
  response.setHeader('Content-Type', 'application/json')
  if (request.method === 'GET' && route.startsWith('next/')) {
    response.end(JSON.stringify(queues.get(route.slice(5))?.shift() || null)); return
  }
  let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) { response.writeHead(413).end(); return } }
  const value = JSON.parse(body || '{}')
  if (route === 'ready') { ready.add(value.label) }
  else if (route === 'trace') traces.push(value)
  else if (route === 'result') {
    results.push(value); const job = pending.get(value.id)
    if (job) { clearTimeout(job.timer); pending.delete(value.id); value.error ? job.reject(Error(value.error)) : job.resolve(value.result) }
  }
  response.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/${token}`
const config = path.join(output, 'config.json')
await fs.writeFile(config, JSON.stringify({ endpoint, profile: output, allowHiddenFrames: process.env.VESPERWIND_MEDIA_ALLOW_HIDDEN_FRAMES === '1' }))
const log = await fs.open(path.join(output, 'app.log'), 'w')
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.join(repo, 'src-tauri/target/debug/bundle/macos/Vesperwind.app/Contents/MacOS/vesperwind')
const testEnvironment = { FILE_MANAGER_ROOT: '/', VESPERWIND_SETTINGS_PATH: path.join(output, 'settings.json'), VESPERWIND_MEDIA_TRACE: '1' }
const child = spawn(binary, ['--media-ui-regression', config],
  { cwd: repo, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...testEnvironment } })

const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
const wait = async (check, timeout = 60000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw Error('Timed out waiting for native UI')
}
const command = (label, action, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native ${label}/${action} timed out`)) }, 60000)
  pending.set(id, { resolve, reject, timer }); const queue = queues.get(label) || []
  queue.push({ id, action, args }); queues.set(label, queue)
})
const history = () => JSON.parse(execFileSync('python3', ['-c',
  'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute("SELECT * FROM media_history ORDER BY path")]))',
  path.join(output, 'media-history.sqlite3')], { encoding: 'utf8' }))
let success = false
try {
  await wait(() => ready.has('main'))
  await command('main', 'navigate', { path: files, side: 'left' })
  await command('main', 'navigate', { path: files, side: 'right' })
  const video = path.join(files, 'media-smoke.mp4')
  for (const gesture of ['doubleclick', 'Space', 'View']) {
    await command('main', 'open', { path: video, gesture })
    await wait(() => ready.has('media-overlay'))
    const result = await command('media-overlay', 'thumbnail')
    console.log(JSON.stringify({ phase: 'video', gesture, ...result }))
    assert.equal(traces.filter(t => t.stage === 'player.open' && t.path === video).at(-1)?.historyEnabled, true)
    await command('media-overlay', 'closeVideo')
    await command('main', 'waitClosedVideo')
  }
  const book = path.join(files, 'book.m4b')
  await command('main', 'open', { path: book })
  assert.equal((await command('main', 'audio', { path: book })).historyEnabled, true)
  await command('main', 'seekPauseAudio', { path: book, seconds: 60 })
  await command('main', 'closeAudio'); await wait(() => history().some(row => row.path === book && row.position >= 59))
  await command('main', 'open', { path: book })
  const resumed = await command('main', 'audio', { path: book })
  assert.ok(resumed.state.currentTime >= 59)
  await command('main', 'seekPauseAudio', { path: book, seconds: 60 })
  const before = history().find(row => row.path === book)
  await command('main', 'open', { path: book, gesture: 'Space' })
  const quick = await command('main', 'audio', { path: book, quick: true })
  assert.equal(quick.historyEnabled, false); assert.ok(quick.state.currentTime < 3)
  await command('main', 'closeQuick')
  assert.deepEqual(history().find(row => row.path === book), before)
  await command('main', 'open', { path: book }); assert.ok((await command('main', 'audio', { path: book })).state.currentTime >= 59)
  console.log(JSON.stringify({ phase: 'audiobook', resumed: true, quickStartsAtZero: true, savedRowUnchanged: true }))
  await command('main', 'closeAudio')
  for (const [index, cloud] of process.argv.slice(3, 5).entries()) {
    await command('main', 'navigate', { path: path.dirname(cloud), side: 'left' })
    await command('main', 'navigate', { path: path.dirname(cloud), side: 'right' })
    await command('main', 'open', { path: cloud, gesture: index === 0 ? 'Space' : 'doubleclick' })
    const playback = await command('main', 'audio', { path: cloud, quick: index === 0 })
    assert.equal(playback.historyEnabled, false); assert.ok(playback.state.duration > 0)
    assert.ok(playback.panels.every(panel => panel.path === path.dirname(cloud) && panel.rows > 1 && !panel.empty && !panel.error))
    await command('main', index === 0 ? 'closeQuick' : 'closeAudio')
    assert.ok(!history().some(row => row.path === cloud))
    console.log(JSON.stringify({ phase: 'cloud-audio', path: cloud, duration: playback.state.duration,
      preparationMessages: playback.preparationMessages, panels: playback.panels, historyUntouched: true }))
  }
  success = true
} finally {
  if (!success && ready.has('main')) { try { console.log(JSON.stringify({ phase: 'failed-ui', snapshot: await command('main', 'inspect') })) } catch {} }
  await fs.writeFile(path.join(output, 'events.ndjson'), traces.map(value => JSON.stringify(value)).join('\n'))
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  void command('main', 'quit').catch(() => {})
  const exit = await Promise.race([exited, new Promise(resolve => setTimeout(() => { child.kill('SIGTERM'); resolve({ code: null, signal: 'SIGTERM' }) }, 3000))])
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Native driver ended')) }
  server.closeAllConnections(); server.close(); await log.close()
  console.log(JSON.stringify({ phase: 'finished', success, hiddenFramesAllowed: process.env.VESPERWIND_MEDIA_ALLOW_HIDDEN_FRAMES === '1', ...exit, output }))
  if (success) assert.equal(exit.code, 0)
}
