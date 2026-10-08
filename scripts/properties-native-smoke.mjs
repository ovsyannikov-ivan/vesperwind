// Opt-in real native AppState/syscall acceptance; no remote credentials required.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const output = process.argv[2] && path.resolve(process.argv[2])
if (!output || fs.existsSync(output)) throw new Error('Provide a new output directory')
fs.mkdirSync(output, { recursive: true })
const binary = process.env.VESPERWIND_NATIVE_BINARY || path.resolve(`src-tauri/target/debug/vesperwind${process.platform === 'win32' ? '.exe' : ''}`)
const log = fs.openSync(path.join(output, 'native.log'), 'w')
const child = spawn(binary, ['--properties-regression', output], { stdio: ['ignore', log, log] })
const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
const receipt = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
clearTimeout(timer); fs.closeSync(log)
if (receipt.code !== 0) { console.error({ ...receipt, output }); process.exit(1) }
const events = JSON.parse(fs.readFileSync(path.join(output, 'events.json')))
if (events.at(-1)?.phase !== 'finished') throw new Error('Native properties acceptance did not finish')
console.log(JSON.stringify({ ...receipt, events: events.map((event) => event.phase), output }))
