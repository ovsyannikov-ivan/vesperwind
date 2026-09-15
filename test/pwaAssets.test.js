import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const publicDirectory = path.join(projectRoot, 'public')

test('provides installable PWA metadata and icon assets', async () => {
  const [html, manifestSource] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'index.html'), 'utf8'),
    fs.readFile(path.join(publicDirectory, 'manifest.webmanifest'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource)

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /rel="icon" href="\/favicon\.ico"/)
  assert.match(html, /name="theme-color"/)
  assert.match(html, /rel="apple-touch-icon"/)
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'))
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'))

  await Promise.all([
    fs.access(path.join(publicDirectory, 'favicon.ico')),
    fs.access(path.join(publicDirectory, 'icons', 'app_icon.png')),
    fs.access(path.join(publicDirectory, 'icons', 'icon-180.png')),
    ...manifest.icons.map((icon) =>
      fs.access(path.join(publicDirectory, icon.src.replace(/^\//, ''))),
    ),
  ])
})

test('registers the PWA service worker only in a secure context', async () => {
  const [mainSource, serviceWorkerSource] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'src', 'main.js'), 'utf8'),
    fs.readFile(path.join(publicDirectory, 'sw.js'), 'utf8'),
  ])

  assert.match(mainSource, /window\.isSecureContext/)
  assert.match(mainSource, /serviceWorker\.register\('\/sw\.js'\)/)
  assert.match(serviceWorkerSource, /self\.skipWaiting\(\)/)
  assert.match(serviceWorkerSource, /self\.clients\.claim\(\)/)
})
