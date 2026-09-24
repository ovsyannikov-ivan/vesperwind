import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFileDragPayload,
  parseFileDragPayload,
} from '../src/utils/fileDrag.js'

test('round-trips a validated file drag payload', () => {
  const value = createFileDragPayload(
    { path: '/Users/ivan/Documents/report.pdf', name: 'report.pdf' },
    'left',
    'local',
  )

  assert.deepEqual(parseFileDragPayload(value), {
    providerId: 'local',
    path: '/Users/ivan/Documents/report.pdf',
    name: 'report.pdf',
    isDirectory: false,
    panelSide: 'left',
  })
})

test('preserves a remote provider in drag and drop payloads', () => {
  const value = createFileDragPayload({ path: '/home/demo/file.txt', name: 'file.txt', isDirectory: false }, 'right', 'sftp:demo')
  assert.equal(parseFileDragPayload(value).providerId, 'sftp:demo')
  assert.equal(parseFileDragPayload(value).path, '/home/demo/file.txt')
})

test('carries selected files and folders in a single drag payload', () => {
  const entries = [
    { path: '/tmp/one.txt', name: 'one.txt', isDirectory: false },
    { path: '/tmp/папка с пробелом', name: 'папка с пробелом', isDirectory: true },
  ]
  const payload = parseFileDragPayload(createFileDragPayload(entries[0], 'left', 'local', entries))
  assert.deepEqual(payload.sources, [
    { ...entries[0], providerId: 'local' },
    { ...entries[1], providerId: 'local' },
  ])
  assert.equal(payload.panelSide, 'left')
})

test('rejects malformed and incomplete drag payloads', () => {
  assert.equal(parseFileDragPayload('not-json'), null)
  assert.equal(parseFileDragPayload(JSON.stringify({ path: '/tmp/file' })), null)
  assert.equal(
    parseFileDragPayload(
      JSON.stringify({
        path: '/tmp/file',
        name: 'file',
        isDirectory: false,
        panelSide: 'left',
      }),
    ),
    null,
  )
  assert.equal(
    parseFileDragPayload(
      JSON.stringify({
        path: '/tmp/file',
        providerId: 'local',
        name: 'file',
        isDirectory: false,
        panelSide: 'middle',
      }),
    ),
    null,
  )
})
