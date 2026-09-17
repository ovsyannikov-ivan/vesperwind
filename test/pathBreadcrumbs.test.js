import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPathBreadcrumbs } from '../src/utils/pathBreadcrumbs.js'

test('builds clickable levels relative to the configured root', () => {
  const breadcrumbs = buildPathBreadcrumbs(
    { name: 'ivan', path: '/Users/ivan' },
    '/Users/ivan/Projects/vesperwind',
  )

  assert.deepEqual(breadcrumbs, [
    { name: 'ivan', path: '/Users/ivan' },
    { name: 'Projects', path: '/Users/ivan/Projects' },
    { name: 'vesperwind', path: '/Users/ivan/Projects/vesperwind' },
  ])
})

test('supports the filesystem root without creating an empty crumb', () => {
  const breadcrumbs = buildPathBreadcrumbs(
    { name: '/', path: '/' },
    '/Users/ivan/Documents',
  )

  assert.deepEqual(breadcrumbs, [
    { name: '/', path: '/' },
    { name: 'Users', path: '/Users' },
    { name: 'ivan', path: '/Users/ivan' },
    { name: 'Documents', path: '/Users/ivan/Documents' },
  ])
})

test('does not expose a path outside the configured root', () => {
  const breadcrumbs = buildPathBreadcrumbs(
    { name: 'ivan', path: '/Users/ivan' },
    '/Users/other',
  )

  assert.deepEqual(breadcrumbs, [{ name: 'ivan', path: '/Users/ivan' }])
})

test('builds Windows drive breadcrumbs without producing a drive-relative path', () => {
  const breadcrumbs = buildPathBreadcrumbs(
    { name: 'C:\\', path: 'C:\\' },
    'C:\\Users\\ivan\\Documents',
  )

  assert.deepEqual(breadcrumbs, [
    { name: 'C:\\', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'ivan', path: 'C:\\Users\\ivan' },
    { name: 'Documents', path: 'C:\\Users\\ivan\\Documents' },
  ])
})

test('builds Windows breadcrumbs relative to a configured home root', () => {
  const breadcrumbs = buildPathBreadcrumbs(
    { name: 'ivan', path: 'C:\\Users\\ivan' },
    'C:\\Users\\ivan\\Documents',
  )

  assert.deepEqual(breadcrumbs, [
    { name: 'ivan', path: 'C:\\Users\\ivan' },
    { name: 'Documents', path: 'C:\\Users\\ivan\\Documents' },
  ])
})
