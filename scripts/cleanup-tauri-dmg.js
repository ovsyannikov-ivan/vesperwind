import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ownerPid = (name) => {
  const match = /^rw\.(\d+)\.Vesperwind_[^/]+\.dmg$/u.exec(name)
  const pid = Number(match?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true }
  catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

const mountedImages = () => {
  const plist = execFileSync('/usr/bin/hdiutil', ['info', '-plist'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  })).images || []
}

// Tauri regenerates bundle_dmg.sh. Run the cleanup before invoking Tauri so the
// policy survives regeneration. The filename PID belongs to create-dmg's shell,
// not to diskimages-helper, which stays alive after an interrupted build.
export const cleanupTauriDmg = async ({
  macosDirectory,
  images = mountedImages(),
  isAlive = processAlive,
  detach = (device) => execFileSync('/usr/bin/hdiutil', ['detach', device], { timeout: 30000, stdio: 'pipe' }),
  log = console.log,
}) => {
  const directory = path.resolve(macosDirectory)
  const mounted = new Set()
  for (const image of images) {
    const file = image['image-path']
    if (typeof file !== 'string' || path.dirname(path.resolve(file)) !== directory) continue
    const name = path.basename(file)
    const pid = ownerPid(name)
    if (!pid) continue
    mounted.add(name)
    try {
      if (!(await fs.lstat(file)).isFile()) continue
    } catch (error) {
      // An interrupted build may already have removed a still-mounted file.
      if (error.code !== 'ENOENT') throw error
    }
    if (isAlive(pid)) {
      log(`Keeping temporary DMG owned by active process ${pid}: ${name}`)
      continue
    }
    const device = image['system-entities']?.find((entity) => /^\/dev\/disk\d+$/u.test(entity['dev-entry']))?.['dev-entry']
    if (!device) throw new Error(`Cannot identify the device of stale DMG ${file}`)
    try { await detach(device) }
    catch (error) { throw new Error(`Cannot detach stale DMG ${file}: ${error.message}`, { cause: error }) }
    mounted.delete(name)
    log(`Detached stale Vesperwind DMG: ${device} (${name})`)
  }

  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    const pid = ownerPid(entry.name)
    if (!entry.isFile() || !pid || mounted.has(entry.name) || isAlive(pid)) continue
    const file = path.join(directory, entry.name)
    // Recheck after enumeration; never follow a link or delete an active build.
    let stat
    try { stat = await fs.lstat(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!stat.isFile() || isAlive(pid)) continue
    try { await fs.unlink(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    log(`Removed stale Vesperwind DMG: ${file}`)
  }
}
