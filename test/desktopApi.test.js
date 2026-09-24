import assert from 'node:assert/strict'
import test from 'node:test'
import { desktop } from '../src/api/desktop.js'

test('browser and SEA desktop API never contact the local GUI backend', async () => {
  for (const action of ['open', 'openWith', 'reveal']) {
    const response = await desktop[action]({ providerId: 'local', path: '/tmp/Unicode файл.txt' })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'ENOTSUPPORTED')
  }
  assert.equal(desktop.available, false)
})
