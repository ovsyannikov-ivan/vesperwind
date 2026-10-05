// Native integration acceptance against the production Vesperwind executable.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] || '')
if (!process.argv[2] || fs.existsSync(output)) throw new Error('Provide a new output directory')
fs.mkdirSync(output, { recursive: true })
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.join(root, `src-tauri/target/debug/vesperwind${process.platform === 'win32' ? '.exe' : ''}`)
const snapshot = () => process.platform === 'darwin' ? execFileSync('/bin/ps', ['-axo', 'pid,ppid,rss,comm'], { encoding: 'utf8' }).split('\n').map((line) => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
  return match && { pid: +match[1], parent: +match[2], rssBytes: +match[3] * 1024, command: match[4] }
}).filter(Boolean) : []
const before = new Set(snapshot().map((p) => p.pid)), samples = []
const log = fs.openSync(path.join(output, 'native.log'), 'w')
const child = spawn(binary, ['--native-regression', output], { cwd: root, stdio: ['ignore', log, log] })
const startedEpochMs = Date.now()
const timer = setInterval(() => {
  const processes = snapshot().filter((p) => p.pid === child.pid || (!before.has(p.pid) && /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(p.command)))
  samples.push({ epochMs: Date.now(), rssSumBytes: processes.reduce((n, p) => n + p.rssBytes, 0), processes })
}, 250)
let timedOut = false
const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 240_000)
const receipt = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
clearInterval(timer); clearTimeout(deadline); fs.closeSync(log)
fs.writeFileSync(path.join(output, 'memory.json'), JSON.stringify({ ...receipt, timedOut, startedEpochMs,
  method: '250ms requested RSS sampling; host plus newly appearing WebKit processes. Temporal attribution of launchd-owned WebKit XPC processes can include other apps; sum can double-count shared pages.', samples }, null, 2))
if (receipt.code !== 0 || timedOut) { console.error(receipt); process.exit(1) }
const events = JSON.parse(fs.readFileSync(path.join(output, 'events.json')))
if (events.at(-1)?.phase !== 'finished') throw new Error('Native acceptance did not finish')
const { validateNativeOutputs } = await import('./validate-native-office.mjs')
const readback = await validateNativeOutputs(output)
fs.writeFileSync(path.join(output, 'readback.json'), JSON.stringify(readback, null, 2))
console.log(JSON.stringify({ ...receipt, outputs: readback.length, events: events.length, output }))
