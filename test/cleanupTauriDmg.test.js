import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupTauriDmg } from '../scripts/cleanup-tauri-dmg.js'

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-dmg-cleanup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'macos')
  await fs.mkdir(directory)
  return { root, directory, file: (name) => path.join(directory, name) }
}
const image = (file, device) => ({ 'image-path': file, 'system-entities': [{ 'dev-entry': device }] })

test('DMG cleanup detaches only orphaned images in this checkout and preserves active builds and links', async (t) => {
  const { root, directory, file } = await fixture(t)
  const names = ['rw.88.Vesperwind_0.1.0_aarch64.dmg', 'rw.89.Vesperwind_0.1.0_aarch64.dmg',
    'rw.91.Vesperwind_0.1.0_aarch64.dmg', 'Vesperwind_0.1.0_aarch64.dmg', 'rw.92.Another_0.1.0.dmg']
  for (const name of names) await fs.writeFile(file(name), 'fixture')
  const linked = file('rw.90.Vesperwind_0.1.0_aarch64.dmg')
  const target = path.join(root, 'keep.dmg')
  await fs.writeFile(target, 'keep')
  await fs.symlink(target, linked)
  const detached = []
  await cleanupTauriDmg({
    macosDirectory: directory,
    images: [image(file(names[0]), '/dev/disk11'), image(file(names[2]), '/dev/disk12'),
      image(linked, '/dev/disk14'),
      image(path.join(root, 'another-checkout', names[0]), '/dev/disk13'),
      image('/System/iOS.dmg', '/dev/disk4')],
    isAlive: (pid) => pid === 91,
    detach: async (device) => { await fs.access(file(names[0])); detached.push(device) },
    log: () => {},
  })
  assert.deepEqual(detached, ['/dev/disk11'])
  for (const name of names.slice(0, 2)) await assert.rejects(fs.access(file(name)), { code: 'ENOENT' })
  for (const name of names.slice(2)) await fs.access(file(name))
  assert.equal((await fs.lstat(linked)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(target, 'utf8'), 'keep')
})

test('a detach failure stops cleanup without deleting the still-mounted image', async (t) => {
  const { directory, file } = await fixture(t)
  const temporary = file('rw.88.Vesperwind_0.1.0_aarch64.dmg')
  await fs.writeFile(temporary, 'fixture')
  await assert.rejects(cleanupTauriDmg({ macosDirectory: directory,
    images: [image(temporary, '/dev/disk11')], isAlive: () => false,
    detach: () => { throw new Error('Resource busy') }, log: () => {},
  }), /Cannot detach stale DMG.*Resource busy/u)
  assert.equal(await fs.readFile(temporary, 'utf8'), 'fixture')
})

test('cleanup rechecks process ownership before deleting an unmounted file', async (t) => {
  const { directory, file } = await fixture(t)
  const temporary = file('rw.88.Vesperwind_0.1.0_aarch64.dmg')
  await fs.writeFile(temporary, 'fixture')
  let checks = 0
  await cleanupTauriDmg({ macosDirectory: directory, images: [],
    isAlive: () => ++checks > 1, log: () => {},
  })
  assert.equal(checks, 2)
  assert.equal(await fs.readFile(temporary, 'utf8'), 'fixture')
})
