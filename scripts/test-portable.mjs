// Acceptance of the distributed EXE. Run this unchanged on a second Windows PC
// with Node.js available as test tooling; the application itself does not use Node.
import fs from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const execFileAsync = promisify(execFile)
const exec = (command, args, options = {}) => {
  if (command.toLowerCase() === 'powershell.exe') {
    command = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    options = { ...options, env: { ...(options.env || process.env), PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } }
  }
  return execFileAsync(command, args, options)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const binary = process.argv[2] && path.resolve(process.argv[2])
const output = process.argv[3] && path.resolve(process.argv[3])
if (process.platform !== 'win32' || !binary || !output) throw Error('Usage: node scripts/test-portable.mjs EXE NEW_REPORT_DIRECTORY')
await fs.mkdir(output) // Refuse to overwrite previous evidence.
const results = []
const first = path.join(output, 'First location')
const moved = path.join(output, 'Перенос приложения')
await fs.mkdir(first); await fs.mkdir(moved)
const local = path.join(output, 'isolated-localappdata')
const roaming = path.join(output, 'isolated-appdata')
const environment = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, PATH: [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter) }
for (const key of ['SHELL', 'VESPERWIND_SETTINGS_PATH', 'VESPERWIND_PORTABLE_DATA_DIR', 'VESPERWIND_LIBMPV_PATH', 'WEBVIEW2_BROWSER_EXECUTABLE_FOLDER', 'WEBVIEW2_USER_DATA_FOLDER']) delete environment[key]
const normalize = value => path.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase()
const copy = async directory => { const destination = path.join(directory, 'Vesperwind.exe'); await fs.copyFile(binary, destination); return destination }
const firstExe = await copy(first)
async function verify(exe, name) {
  const report = path.join(output, `${name}.json`)
  await exec(exe, ['--portable-verify', '--portable-report', report], { cwd: output, env: environment, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(await fs.readFile(report, 'utf8'))
}
const cold = await verify(firstExe, 'cold')
assert.equal(cold.cacheReused, false)
assert.equal(normalize(cold.dataDir), normalize(path.join(first, 'Vesperwind.data')))
const warm = await verify(firstExe, 'warm'); assert.equal(warm.cacheReused, true)
results.push('cold extraction; verified warm cache; default adjacent data directory')
const blockedData = path.join(output, 'data-is-a-file')
await fs.writeFile(blockedData, 'preserve this file')
await assert.rejects(exec(firstExe, ['--portable-verify', '--portable-data-dir', blockedData], { env: environment, windowsHide: true, timeout: 60_000 }))
assert.equal(await fs.readFile(blockedData, 'utf8'), 'preserve this file')
await assert.rejects(exec(firstExe, ['--portable-verify', '--portable-data-dir', cold.runtimeDir], { env: environment, windowsHide: true, timeout: 60_000 }))
results.push('invalid data directory and data/cache overlap fail without falling back to APPDATA')
const concurrent = await Promise.all([verify(firstExe, 'parallel-1'), verify(firstExe, 'parallel-2')])
assert.ok(concurrent.every(report => report.cacheReused))
const runtime = cold.runtimeDir
const file = await fs.open(path.join(runtime, 'vesperwind-archive.exe'), 'r+')
await file.write(Buffer.from('BAD!'), 0, 4, 0); await file.close()
await fs.unlink(path.join(runtime, 'PORTABLE.txt'))
await fs.writeFile(path.join(runtime, 'unexpected.dll'), 'untrusted')
const repaired = await verify(firstExe, 'repaired'); assert.equal(repaired.cacheReused, false)
assert.equal(await fs.readFile(path.join(runtime, 'vesperwind-archive.exe')).then(bytes => bytes.subarray(0, 2).toString()), 'MZ')
await fs.access(path.join(runtime, 'PORTABLE.txt'))
await assert.rejects(fs.access(path.join(runtime, 'unexpected.dll')))
results.push('concurrent starts; repair of corrupt, missing and unexpected cache files')
await fs.writeFile(path.join(first, 'Vesperwind.data', 'settings.json'), JSON.stringify({ appearance: { theme: 'light' } }))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let error
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch (e) { error = e }
    await delay(200)
  }
  throw Error(`Acceptance timed out: ${error?.message || 'no result'}`)
}
async function cdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data); const item = pending.get(value.id)
    if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(JSON.stringify(value.error))) : item.resolve(value.result) }
  })
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timed out: ${method}`)) }, 90_000)
        pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
  }
}
async function appAcceptance(exe, expectedTheme, name, full) {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  const report = path.join(output, `${name}-launcher.json`)
  const log = openSync(path.join(output, `${name}.log`), 'w')
  const child = spawn(exe, ['--portable-report', report], { cwd: output, env: { ...environment, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, windowsHide: true, stdio: ['ignore', log, log] })
  let receipt
  const exited = new Promise(resolve => { child.once('error', error => { receipt = { error: error.message }; resolve(receipt) }); child.once('exit', (code, signal) => { receipt = { code, signal }; resolve(receipt) }) })
  let connection
  try {
    const page = await waitFor(async () => {
      if (receipt) throw Error(`Application exited: ${JSON.stringify(receipt)}`)
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
      return targets.find(target => target.type === 'page' && /tauri\.localhost/.test(target.url))
    })
    connection = await cdp(page.webSocketDebuggerUrl)
    const evaluate = async expression => {
      const response = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails))
      return response.result.value
    }
    await waitFor(() => evaluate("Boolean(window.__TAURI_INTERNALS__ && document.querySelectorAll('.file-panel').length === 2)"))
    const invoke = async (command, payload = {}) => {
      const response = await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, {payload: ${JSON.stringify(payload)}})`)
      assert.equal(response?.ok, true, `${command}: ${JSON.stringify(response)}`); return response
    }
    const settings = await invoke('settings_get')
    assert.equal(settings.settings.appearance.theme, expectedTheme)
    assert.equal(normalize(settings.storagePath), normalize(path.join(path.dirname(exe), 'Vesperwind.data/settings.json')))
    const loaded = await invoke('filesystem_list', { filesystemId: 'local', path: output })
    assert.ok(loaded.entries.length > 0)
    if (full) {
      settings.settings.appearance.theme = 'dark'
      await invoke('settings_update', { settings: settings.settings })
      await evaluate("localStorage.setItem('portable-acceptance', 'preserved')")
      await evaluate(`(async () => {
        window.__portableTerminal = { output: '', exits: [] };
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
          event: 'terminal:output', target: {kind: 'Any'},
          handler: window.__TAURI_INTERNALS__.transformCallback(event => {
            window.__portableTerminal.output += event.payload.data;
            // Supply the cursor-position reply normally sent by xterm.js.
            if (event.payload.data.includes('\\x1b[6n')) void window.__TAURI_INTERNALS__.invoke('terminal_input', {payload: {id: event.payload.id, data: '\\x1b[1;1R'}});
          })
        });
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
          event: 'terminal:exit', target: {kind: 'Any'},
          handler: window.__TAURI_INTERNALS__.transformCallback(event => window.__portableTerminal.exits.push(event.payload))
        });
        return true;
      })()`)
      const terminal = await invoke('terminal_create', { cols: 80, rows: 24 })
      const terminalMarker = path.join(output, 'terminal-ok.txt')
      try {
        await waitFor(() => evaluate("window.__portableTerminal.output.includes('>')"))
        await invoke('terminal_input', { id: terminal.id, data: `[IO.File]::WriteAllText('${terminalMarker.replaceAll("'", "''")}', 'PORTABLE_TERMINAL_OK')\r` })
        await waitFor(() => fs.readFile(terminalMarker, 'utf8').then(text => text === 'PORTABLE_TERMINAL_OK'))
      } finally {
        await fs.writeFile(path.join(output, 'terminal.json'), JSON.stringify(await evaluate('window.__portableTerminal'), null, 2))
      }
      await invoke('terminal_close', { id: terminal.id })
      const archiveInput = path.join(output, 'archive-input.txt')
      await fs.writeFile(archiveInput, 'Portable archive round trip')
      await invoke('archive_start', { jobId: 'portable-create', action: 'create', sources: [{ providerId: 'local', path: archiveInput }], target: { providerId: 'local', path: output }, name: 'portable.zip' })
      await waitFor(() => fs.stat(path.join(output, 'portable.zip')).then(stat => stat.size > 0))
      await waitFor(async () => {
        const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('archive_start', {payload: ${JSON.stringify({ jobId: 'portable-extract', action: 'extract', sources: [{ providerId: 'local', path: path.join(output, 'portable.zip') }], target: { providerId: 'local', path: output }, name: 'unpacked' })}})`)
        if (result.error?.code === 'EARCHIVE_BUSY') return false
        assert.equal(result.ok, true, JSON.stringify(result)); return true
      })
      await waitFor(() => fs.readFile(path.join(output, 'unpacked/archive-input.txt'), 'utf8').then(text => text === 'Portable archive round trip'))
      const rtf = await fs.readFile(path.join(root, 'test/fixtures/document/simple.rtf'))
      const converted = await invoke('document_convert', { format: 'rtf', base64: rtf.toString('base64'), operationId: 'portable-rtf', timeoutMs: 60_000 })
      const docx = Buffer.from(converted.base64, 'base64'); assert.equal(docx.subarray(0, 2).toString(), 'PK')
      await fs.writeFile(path.join(output, 'converted.docx'), docx)
      const media = path.join(output, 'portable-video.mp4')
      await fs.copyFile(path.join(root, 'test/fixtures/media/native-h264.mp4'), media)
      const capabilities = await invoke('player_capabilities')
      assert.ok(normalize(capabilities.capabilities.libraryPath).startsWith(normalize(cold.runtimeDir)))
      await fs.writeFile(path.join(output, 'player-capabilities.json'), JSON.stringify(capabilities, null, 2))
      const player = await invoke('player_open', { sessionId: 'portable-video', sourceType: 'provider', filesystemId: 'local', path: media, kind: 'video', autoplay: false, geometry: { x: 120, y: 100, width: 480, height: 270 } })
      await fs.writeFile(path.join(output, 'player-open.json'), JSON.stringify(player, null, 2))
      const state = await invoke('player_snapshot', { sessionId: 'portable-video' })
      await fs.writeFile(path.join(output, 'player-state.json'), JSON.stringify(state, null, 2))
      await invoke('player_seek', { sessionId: 'portable-video', seconds: 0.2 })
      await invoke('player_close', { sessionId: 'portable-video' })
      const screenshot = await connection.send('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(path.join(output, 'application.png'), Buffer.from(screenshot.data, 'base64'))
      // Inspect only children of our launcher, proving that the bundled runtime was selected.
      const processes = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $app=Get-CimInstance Win32_Process -Filter "ParentProcessId = $env:PORTABLE_TEST_PID" | Where-Object Name -eq "vesperwind.exe"; if (!$app) { throw "App process missing" }; Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.ProcessId)" | Select-Object Name,ExecutablePath | ConvertTo-Json'], { env: { ...process.env, PORTABLE_TEST_PID: String(child.pid) }, windowsHide: true })
      const runtimeProcesses = JSON.parse(processes.stdout)
      assert.ok([runtimeProcesses].flat().some(process => process.Name === 'msedgewebview2.exe' && normalize(process.ExecutablePath).startsWith(normalize(cold.runtimeDir))))
      await fs.writeFile(path.join(output, 'runtime-processes.json'), processes.stdout)
    } else {
      assert.equal(await evaluate("localStorage.getItem('portable-acceptance')"), 'preserved')
    }
    // Native WM_CLOSE preserves normal application shutdown and window-state persistence.
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $app=Get-CimInstance Win32_Process -Filter "ParentProcessId = $env:PORTABLE_TEST_PID" | Where-Object Name -eq "vesperwind.exe"; if (!$app) { throw "App process missing" }; if (!(Get-Process -Id $app.ProcessId).CloseMainWindow()) { throw "Cannot close app window" }'], { env: { ...process.env, PORTABLE_TEST_PID: String(child.pid) }, windowsHide: true })
    let shutdownTimer
    const exit = await Promise.race([exited, new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(Error('Application did not shut down')), 30_000) })]).finally(() => clearTimeout(shutdownTimer))
    assert.equal(exit.code, 0)
  } finally {
    connection?.close()
    if (!receipt) await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    closeSync(log)
  }
}
await appAcceptance(firstExe, 'light', 'first-app', true)
results.push('actual bundled WebView2; two rendered panels; portable settings; local PTY; archive round trip; RTF to DOCX; native video open/seek/close')
await fs.access(path.join(first, 'Vesperwind.data/media-history.sqlite3'))
await fs.access(path.join(first, 'Vesperwind.data/window-state.json'))
await fs.cp(path.join(first, 'Vesperwind.data'), path.join(moved, 'Vesperwind.data'), { recursive: true })
const movedExe = await copy(moved)
await appAcceptance(movedExe, 'dark', 'moved-app', false)
await assert.rejects(fs.access(path.join(roaming, 'Vesperwind/settings.json')))
results.push('relocation into a Unicode path preserves settings, WebView localStorage, history and window state')
await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({ schema: 1, host: 'current Windows machine; relocation is not a second-PC test', binary, results }, null, 2))
console.log(JSON.stringify({ output, results }, null, 2))
