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
