import assert from 'node:assert/strict'
import test from 'node:test'
import { createArchiveClient } from '../src/api/archives.js'
const request = { action: 'create', name: 'files.zip', sources: [{ providerId: 'local', path: '/source' }], target: { providerId: 'local', path: '/target' } }
const deferred = () => { let resolve; return { promise: new Promise((r) => { resolve = r }), resolve: (value) => resolve(value) } }
test('archive requests await listener readiness and isolate job IDs', async () => {
  const ready = deferred(), calls = [], events = []; let notify
  const client = createArchiveClient({ subscribe: (_, cb) => { notify = cb; const stop = () => {}; stop.ready = ready.promise; return stop }, request: async (event, payload) => { calls.push({ event, payload }); return { ok: true } } })
  const job = client(request, (event) => events.push(event)); assert.equal(calls.length, 0)
  ready.resolve(true); await job.started
  notify({ jobId: 'stale', done: true }); assert.equal(events.length, 0)
  notify({ jobId: job.jobId, entries: 1 }); assert.equal(events.length, 1)
  job.dispose(); notify({ jobId: job.jobId, done: true }); assert.equal(events.length, 1)
  assert.equal(calls.at(-1).event, 'archive:cancel')
})
test('cancel before readiness prevents launch; pending acknowledgement repeats cancellation', async () => {
  const ready = deferred(), ack = deferred(), calls = []
  const transport = { subscribe: () => { const stop = () => {}; stop.ready = ready.promise; return stop }, request: (event) => { calls.push(event); return event === 'archive:start' ? ack.promise : Promise.resolve({ ok: true }) } }
  const client = createArchiveClient(transport)
  const early = client(request, () => {}); early.cancel(); ready.resolve(true); await early.started
  assert.equal(calls.length, 0)
  const pending = client(request, () => {}); await Promise.resolve(); pending.cancel(); ack.resolve({ ok: true }); await pending.started
  assert.deepEqual(calls, ['archive:start', 'archive:cancel', 'archive:cancel']); pending.dispose()
})
test('disconnect finishes busy UI once, detaches listeners and ignores stale events after reconnect', async () => {
  const events = [], calls = []; let progress, connection, progressStops = 0, connectionStops = 0
  const client = createArchiveClient({
    subscribe: (_, cb) => { progress = cb; return () => { progressStops++ } },
    subscribeToConnection: (cb) => { connection = cb; return () => { connectionStops++ } },
    request: async (event) => { calls.push(event); return { ok: true } },
  })
  let busy = true, error
  const job = client(request, (event) => { events.push(event); if (event.done) { busy = false; error = event.error } })
  await job.started
  connection(false)
  assert.equal(busy, false); assert.equal(error.code, 'ECONNECTION_LOST')
  assert.equal(progressStops, 1); assert.equal(connectionStops, 1)
  connection(true); progress({ jobId: job.jobId, done: true, result: {} }); connection(false)
  job.cancel(); job.dispose()
  assert.equal(events.length, 1); assert.deepEqual(calls, ['archive:start'])
})
test('disconnect during listener setup or pending start acknowledgement cannot relaunch or enqueue cancellation', async () => {
  for (const beforeReady of [true, false]) {
    const ready = deferred(), ack = deferred(), calls = [], events = []; let connection
    const client = createArchiveClient({
      subscribe: () => { const stop = () => {}; stop.ready = ready.promise; return stop },
      subscribeToConnection: (cb) => { connection = cb; return () => {} },
      request: (event) => { calls.push(event); return ack.promise },
    })
    const job = client(request, (event) => events.push(event))
    if (!beforeReady) { ready.resolve(true); await Promise.resolve(); await Promise.resolve() }
    connection(false); ready.resolve(true); ack.resolve({ ok: true }); await job.started
    assert.deepEqual(calls, beforeReady ? [] : ['archive:start'])
    assert.equal(events.length, 1); assert.equal(events[0].error.code, 'ECONNECTION_LOST')
  }
})
