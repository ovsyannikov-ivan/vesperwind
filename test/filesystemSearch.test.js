import assert from 'node:assert/strict'
import test from 'node:test'
import { createFilesystemSearchClient } from '../src/api/filesystemSearch.js'

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }

test('native search waits for listener readiness before starting traversal', async () => {
  const listenerReady = deferred()
  const calls = []
  let notify
  const transport = {
    subscribe: (_, callback) => { notify = callback; const stop = () => {}; stop.ready = listenerReady.promise; return stop },
    request: async (event, payload) => {
      calls.push(event)
      if (event === 'filesystem:search') notify({ searchId: payload.searchId, entries: [{ path: '/a' }] })
      return { ok: true }
    },
  }
  const received = []
  const handle = createFilesystemSearchClient(transport)({ query: 'a' }, (event) => received.push(event))
  assert.deepEqual(calls, [])
  listenerReady.resolve(true)
  await handle.started
  assert.deepEqual(calls, ['filesystem:search'])
  assert.equal(received[0].entries[0].path, '/a')
})

test('cancel before listener readiness prevents traversal and concurrent searches stay isolated', async () => {
  const ready = deferred()
  const listeners = []
  const calls = []
  const transport = {
    subscribe: (_, callback) => { listeners.push(callback); const stop = () => {}; stop.ready = ready.promise; return stop },
    request: async (event, payload) => { calls.push({ event, payload }); return { ok: true } },
  }
  const client = createFilesystemSearchClient(transport)
  const firstEvents = []; const secondEvents = []
  const first = client({ query: 'first' }, (event) => firstEvents.push(event))
  first.cancel()
  const second = client({ query: 'second' }, (event) => secondEvents.push(event))
  ready.resolve(true)
  await Promise.all([first.started, second.started])
  assert.equal(calls.filter((call) => call.event === 'filesystem:search').length, 1)
  listeners.forEach((listener) => listener({ searchId: second.searchId, entries: [{ path: '/second' }] }))
  assert.equal(firstEvents.length, 0)
  assert.equal(secondEvents[0].entries[0].path, '/second')
})
