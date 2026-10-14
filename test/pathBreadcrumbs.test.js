import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPathBreadcrumbs } from '../src/utils/pathBreadcrumbs.js'
import { COMPUTER_PATH, isFilesystemRootEntry } from '../shared/localFilesystem.js'
import { restorePanelViewState } from '../src/utils/panelSwap.js'
import { remoteAddress } from '../shared/remoteAddress.js'

const macRoot = { name: 'Macintosh HD', path: '/', navigation: {
  computer: { name: 'Mac mini', path: COMPUTER_PATH },
  volumes: [{ name: 'Macintosh HD', path: '/' }, { name: 'WD 1TB', path: '/Volumes/WD 1TB' },
    { name: 'Team share', path: '/Volumes/Team', type: 'network-volume' }],
} }

test('macOS breadcrumbs use computer and the containing mounted volume, with real paths', () => {
  assert.deepEqual(buildPathBreadcrumbs(macRoot, '/Users/ivan'), [
    { name: 'Mac mini', path: COMPUTER_PATH }, { name: 'Macintosh HD', path: '/' },
    { name: 'Users', path: '/Users' }, { name: 'ivan', path: '/Users/ivan' },
  ])
  assert.deepEqual(buildPathBreadcrumbs(macRoot, '/Volumes/WD 1TB/Movies'), [
    { name: 'Mac mini', path: COMPUTER_PATH }, { name: 'WD 1TB', path: '/Volumes/WD 1TB' },
    { name: 'Movies', path: '/Volumes/WD 1TB/Movies' },
  ])
  assert.deepEqual(buildPathBreadcrumbs(macRoot, '/Volumes/Team/docs'), [
    { name: 'Mac mini', path: COMPUTER_PATH }, { name: 'Team share', path: '/Volumes/Team' },
    { name: 'docs', path: '/Volumes/Team/docs' },
  ])
  assert.equal(buildPathBreadcrumbs(macRoot, '/Volumes/Team-old')[1].name, 'Macintosh HD', 'volume matching respects path boundaries')
  assert.deepEqual(buildPathBreadcrumbs(macRoot, COMPUTER_PATH), [{ name: 'Mac mini', path: COMPUTER_PATH }])
})

test('macOS computer navigation survives panel swaps and volume roots are protected', () => {
  const computer = { name: 'Mac mini', path: COMPUTER_PATH, isDirectory: true }
  assert.equal(restorePanelViewState({ providerId: 'local', root: computer }, 'local', macRoot, macRoot).root, computer)
  assert.equal(restorePanelViewState({ providerId: 'local', root: {} }, 'local', { path: '/' }, macRoot).restored, false)
  assert.equal(isFilesystemRootEntry({ path: '/Volumes/WD 1TB', type: 'volume' }), true)
  assert.equal(isFilesystemRootEntry({ path: '/Volumes/Team', type: 'network-volume' }), true)
  assert.equal(isFilesystemRootEntry({ path: '/Volumes/Team/docs', type: 'directory' }), false)
})

test('remote endpoint labels cover protocols, nonstandard ports and IPv6 without credentials', () => {
  for (const [protocol, ftpTls, port, host, label] of [
    ['sftp', '', 22, '192.168.9.18', '192.168.9.18'],
    ['sftp', '', 2222, 'server.example', 'server.example:2222'],
    ['ftp', '', 21, 'ftp.example', 'ftp.example'],
    ['ftps', 'explicit', 21, 'ftp.example', 'ftp.example'],
    ['ftps', 'implicit', 990, 'ftp.example', 'ftp.example'],
    ['ftps', 'implicit', 9990, '2001:db8::1', '[2001:db8::1]:9990'],
  ]) assert.equal(remoteAddress({ protocol, ftpTls, port, host, username: 'private', password: 'secret' }), label)
  assert.deepEqual(buildPathBreadcrumbs({ name: '192.168.9.18', path: '/' }, '/var/www'), [
    { name: '192.168.9.18', path: '/' }, { name: 'var', path: '/var' }, { name: 'www', path: '/var/www' },
  ])
})

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
