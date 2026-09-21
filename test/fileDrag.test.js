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
