import test from 'node:test'
import assert from 'node:assert/strict'
import { createTauriRequester } from '../src/api/transports/tauri.js'
import { createSocketRequester } from '../src/api/transports/socket.js'
import { settleFileOperation } from '../src/composables/fileOperationLifecycle.js'
const tick = () => new Promise((r) => setTimeout(r, 5))

test('Tauri honors timeout, cancels the matching native job, ignores late output, and accepts the next request', async () => {
  const calls = []; let late
  const request = createTauriRequester((command, args) => {
    calls.push({ command, args })
    if (command === 'filesystem_operation_cancel') return Promise.resolve({ ok: true })
    if (args.payload.sourcePath === '/stuck') return new Promise((r) => { late = r })
    return Promise.resolve({ ok: true, result: args.payload.sourcePath })
  })
  let busy = false, refreshes = 0, completions = 0
  const response = await settleFileOperation({
    run: () => request('filesystem:operate', { action: 'delete', sourcePath: '/stuck' }, { timeout: 25 }).then((r) => { completions++; return r }),
    setBusy: (value) => { busy = value }, refresh: () => { refreshes++ },
  })
  assert.equal(response.error.code, 'ETIMEDOUT'); assert.equal(response.error.path, '/stuck')
  assert.equal(busy, false); assert.equal(refreshes, 1)
  assert.equal(calls[1].command, 'filesystem_operation_cancel')
  assert.equal(calls[0].args.payload.operationId, calls[1].args.payload.operationId)
  const next = await request('filesystem:operate', { action: 'delete', sourcePath: '/next' }, { timeout: 100 })
  late({ ok: true }); await tick()
  assert.equal(next.ok, true); assert.equal(completions, 1)
  assert.notEqual(calls[2].args.payload.operationId, calls[0].args.payload.operationId)
})

test('every failure releases confirmation busy and refreshes partial deletion; a successful retry remains usable', async () => {
  for (const code of ['EACCES', 'EROFS', 'EBUSY', 'ENOTEMPTY', 'ENOENT', 'ETIMEDOUT', 'ECANCELLED', 'EWORKER_LOST', 'ETAURI_INVOKE']) {
    let busy = false, refreshes = 0
    const options = { setBusy: (v) => { busy = v }, refresh: () => { refreshes++ } }
    const failure = await settleFileOperation({ ...options, run: async () => { assert.equal(busy, true); return { ok: false, error: { code } } } })
    assert.equal(failure.error.code, code); assert.equal(busy, false); assert.equal(refreshes, 1)
    assert.equal((await settleFileOperation({ ...options, run: async () => ({ ok: true }) })).ok, true)
    assert.equal(busy, false); assert.equal(refreshes, 1)
  }
})

test('transport exception and superseded owner cannot leave or overwrite busy state', async () => {
  let busy = false, current = true, late
  const pending = settleFileOperation({ run: () => new Promise((r) => { late = r }), setBusy: (v) => { busy = v }, refresh: () => assert.fail(), isCurrent: () => current })
  current = false; busy = false
  late({ ok: false }); await pending; assert.equal(busy, false)
  const response = await settleFileOperation({ run: () => { throw new Error('Native channel lost') }, setBusy: (v) => { busy = v }, refresh: () => {} })
  assert.equal(response.ok, false); assert.equal(busy, false)
})

test('cancelling Office requests invalidates the native identity, including pre-aborted requests', async () => {
  const calls = []; const request = createTauriRequester((command, args) => { calls.push({ command, args }); return new Promise(() => {}) })
  const controller = new AbortController()
  const pending = request('document:convert', { format: 'pptx' }, { signal: controller.signal, timeout: 1000 })
  await tick(); controller.abort()
  assert.equal((await pending).error.code, 'ECANCELLED')
  assert.equal(calls[1].command, 'document_cancel')
  assert.equal(calls[1].args.payload.operationId, calls[0].args.payload.operationId)
})

test('socket SFTP timeout leaves the next operation usable and ignores a late acknowledgement', async () => {
  let callback, timeout
  const request = createSocketRequester(() => ({ timeout: (ms) => { timeout = ms; return { emit: (_name, _payload, ack) => { callback = ack } } } }))
  const failed = request('filesystem:operate', { filesystemId: 'sftp:test' }, { timeout: 30_000 })
  assert.equal(timeout, 30_000); const late = callback; callback(new Error('network lost'))
  assert.equal((await failed).error.code, 'ETIMEDOUT')
  const next = request('filesystem:operate', { filesystemId: 'sftp:test' }, { timeout: 120_000 })
  callback(null, { ok: true }); late(null, { ok: true }); assert.equal((await next).ok, true)
})
