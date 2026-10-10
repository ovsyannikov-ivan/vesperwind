import test from 'node:test'
import assert from 'node:assert/strict'
import { createTauriRequester } from '../src/api/transports/tauri.js'
import { createSocketRequester } from '../src/api/transports/socket.js'
import { settleFileOperation } from '../src/composables/fileOperationLifecycle.js'
const tick = () => new Promise((r) => setTimeout(r, 5))

test('permission preparation outlives IO timeout, preserves the real response, and is cancellable', async () => {
  let reply; const calls = []
  const request = createTauriRequester((command, args) => {
    calls.push({ command, args })
    if (command === 'permissions_cancel') return Promise.resolve({ ok: true })
    return new Promise(resolve => { reply = resolve })
  })
  let settled = false
  const waiting = request('permissions:prepare-folder', { path: '/Users/fixture/Documents' }, { timeout: 10 }).then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(settled, false, 'waiting for a system decision must not become an IO timeout')
  reply({ ok: true }); assert.equal((await waiting).ok, true)
  const controller = new AbortController()
  const cancelled = request('permissions:request', { kind: 'network' }, { signal: controller.signal })
  await tick(); const late = reply; controller.abort()
  assert.equal((await cancelled).error.code, 'ECANCELLED')
  assert.equal(calls.at(-1).command, 'permissions_cancel')
  assert.equal(calls.at(-1).args.payload.requestId, calls.at(-2).args.payload.requestId)
  late({ ok: true }); await tick()
  const denied = request('permissions:prepare-folder', { path: '/Users/fixture/Documents' })
  await tick(); reply({ ok: false, error: { code: 'EPERMISSION_DENIED', message: 'Access was denied' } })
  assert.equal((await denied).error.code, 'EPERMISSION_DENIED')
  const immediate = new AbortController(); const count = calls.length
  const neverStarted = request('permissions:request', { kind: 'network' }, { signal: immediate.signal })
  immediate.abort(); await neverStarted; await tick()
  assert.equal(calls.length, count, 'an immediate cancellation must not start or orphan a native permission request')
})

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

test('native remote copy and move are bounded by inactivity, not a fixed two-minute deadline', async () => {
  const { operationTimeout, NATIVE_TRANSFER_TIMEOUT, REMOTE_OPERATION_TIMEOUT, OPERATION_TIMEOUT, DELETE_TIMEOUT } =
    await import('../src/api/filesystem.js')
  const at = (providerId) => ({ providerId, path: '/a' })
  for (const provider of ['sftp:p', 'ftp:p', 'ftps:p']) {
    for (const action of ['copy', 'move']) {
      assert.equal(operationTimeout(action, at(provider), at('local'), 'tauri'), NATIVE_TRANSFER_TIMEOUT)
      assert.equal(operationTimeout(action, at('local'), at(provider), 'tauri'), NATIVE_TRANSFER_TIMEOUT)
      // The Socket.IO backend has no inactivity watchdog: it keeps the deadline.
      assert.equal(operationTimeout(action, at(provider), at('local'), 'browser'), REMOTE_OPERATION_TIMEOUT)
    }
    assert.equal(operationTimeout('rename', at(provider), null, 'tauri'), REMOTE_OPERATION_TIMEOUT)
    assert.equal(operationTimeout('delete', at(provider), null, 'tauri'), DELETE_TIMEOUT)
  }
  assert.equal(operationTimeout('copy', at('local'), at('local'), 'tauri'), OPERATION_TIMEOUT)
})
