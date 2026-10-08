import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { getContentAvailabilityBadge } from '../src/utils/contentAvailability.js'
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

test('FileTreeNode renders the reactive badge beside the name with a title and accessible label', async () => {
  const source = await readFile(new URL('../src/components/FileTreeNode.vue', import.meta.url), 'utf8')
  assert.match(source, /computed\(\(\) => getContentAvailabilityBadge\(props.node, props.providerId\)\)/)
  const badge = source.slice(source.indexOf('v-if="availabilityBadge"'), source.indexOf('v-if="node.isSymbolicLink"'))
  assert.match(badge, /tree-content-badge/)
  assert.match(badge, /role="img"/)
  assert.match(badge, /:aria-label="availabilityBadge.label"/)
  assert.match(badge, /:title="availabilityBadge.label"/)
  assert.ok(source.indexOf('class="tree-label"') < source.indexOf('class="mdi tree-content-badge"'))
})
