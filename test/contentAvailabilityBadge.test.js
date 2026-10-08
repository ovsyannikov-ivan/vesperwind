import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { getContentAvailabilityBadge, getFileStatusBadge } from '../src/utils/contentAvailability.js'
import { getFileIcon } from '../src/utils/fileIcons.js'

const entry = (availability) => ({ name: 'Report.pdf', isDirectory: false, contentAvailability: availability })

test('cloud availability adds a status badge while retaining the file-type icon', () => {
  const file = entry({ state: 'cloud' })
  assert.deepEqual(getContentAvailabilityBadge(file), {
    icon: 'mdi-cloud-download-outline', label: 'Stored in iCloud — download required',
  })
  assert.equal(getFileIcon(file).icon, 'mdi-file-pdf-box')
})

test('ready, unknown, missing and null availability have no status badge', () => {
  for (const value of [undefined, null, { state: 'ready' }, { state: 'unknown' }]) {
    assert.equal(getContentAvailabilityBadge(entry(value)), null)
  }
})

test('materializing is distinct and only valid reported progress becomes a percentage', () => {
  assert.deepEqual(getContentAvailabilityBadge(entry({ state: 'materializing', progress: 0.42 })), {
    icon: 'mdi-cloud-sync-outline', label: 'Downloading from iCloud — 42%',
  })
  for (const progress of [undefined, null, NaN, Infinity, -1, 1.01, '0.42']) {
    assert.equal(getContentAvailabilityBadge(entry({ state: 'materializing', progress })).label, 'Downloading from iCloud')
  }
})

test('failure has an accessible error badge; SFTP does not display local cloud state', () => {
  assert.equal(getContentAvailabilityBadge(entry({ state: 'failed' })).icon, 'mdi-cloud-alert-outline')
  assert.equal(getContentAvailabilityBadge(entry(undefined), 'sftp:server'), null)
  assert.equal(getContentAvailabilityBadge(entry({ state: 'cloud' }), 'sftp:server'), null)
})

test('FileTreeNode renders one accessible status in the column before size', async () => {
  const source = await readFile(new URL('../src/components/FileTreeNode.vue', import.meta.url), 'utf8')
  assert.match(source, /computed\(\(\) => getFileStatusBadge\(props.node, props.providerId\)\)/)
  const badge = source.slice(source.indexOf('class="tree-status-cell"'), source.indexOf('class="tree-size"'))
  assert.match(badge, /tree-content-badge/)
  assert.match(badge, /role="img"/)
  assert.match(badge, /:aria-label="statusBadge.label"/)
  assert.match(badge, /:title="statusBadge.label"/)
  assert.equal((badge.match(/class="mdi tree-content-badge"/g) || []).length, 1)
  assert.ok(source.indexOf('tree-link-badge') < source.indexOf('class="tree-status-cell"'))
  assert.ok(source.indexOf('class="tree-label"') < source.indexOf('class="mdi tree-content-badge"'))
})

test('OneDrive labels preserve availability and synchronization as independent facts', () => {
  const file = { ...entry({ state: 'cloud', provider: 'onedrive' }),
    cloudSync: { provider: 'onedrive', state: 'inSync', inspection: 'ok', localContent: 'notFullyLocal', pinPolicy: 'pinned' } }
  assert.equal(getContentAvailabilityBadge(file).label, 'Stored in OneDrive — download required')
  assert.equal(getFileStatusBadge(file).icon, 'mdi-cloud-outline')
  assert.match(getFileStatusBadge(file).label, /download required.*synchronized/)
  assert.equal(getFileIcon(file).icon, 'mdi-file-pdf-box')
  assert.equal(getFileStatusBadge(file, 'sftp:server'), null)
})

test('PARTIAL alone conveys unreadiness, without claiming missing content or an active download', () => {
  assert.deepEqual(getContentAvailabilityBadge(entry({ state: 'notReady', provider: 'onedrive' })), {
    icon: 'mdi-cloud-clock-outline', label: 'OneDrive content is not ready for reading',
  })
  assert.equal(getContentAvailabilityBadge(entry({ state: 'notReady' })), null)
  assert.equal(getContentAvailabilityBadge(entry({ state: 'materializing', provider: 'onedrive', progress: 0.25 })).label, 'Downloading from OneDrive — 25%')
  assert.equal(getContentAvailabilityBadge(entry({ state: 'failed', provider: 'onedrive' })).label, 'Unable to determine or download OneDrive content')
})

test('local availability and pinning use distinct checks; notInSync never claims active syncing', () => {
  assert.equal(getContentAvailabilityBadge(entry({ state: 'cloud', provider: 'other' })), null)
  const local = { cloudSync: { provider: 'onedrive', state: 'inSync', inspection: 'ok', localContent: 'present' } }
  assert.equal(getFileStatusBadge(local).icon, 'mdi-check-circle-outline')
  assert.equal(getFileStatusBadge({ cloudSync: { ...local.cloudSync, pinPolicy: 'pinned' } }).icon, 'mdi-check-circle')
  const pending = getFileStatusBadge({ cloudSync: { ...local.cloudSync, state: 'notInSync' } })
  assert.equal(pending.icon, 'mdi-clock-outline')
  assert.match(pending.label, /locally available.*not marked/)
  for (const cloudSync of [undefined, null, { provider: 'other', state: 'inSync', inspection: 'ok' },
    { provider: 'onedrive', state: 'unknown', inspection: 'ok' }]) {
    assert.equal(getFileStatusBadge({ cloudSync }), null)
  }
  assert.equal(getFileStatusBadge({ cloudSync: { ...local.cloudSync, inspection: 'error' } }).icon, 'mdi-alert-circle-outline')
  assert.equal(getFileStatusBadge({ cloudSync: { ...local.cloudSync, localContent: 'unknown', pinPolicy: 'pinned' } }), null)
})
