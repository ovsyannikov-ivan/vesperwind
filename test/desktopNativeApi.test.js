import assert from 'node:assert/strict'
import test from 'node:test'

const calls = []
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      calls.push({ command, args })
      return { ok: true }
    },
  },
}
const { desktop } = await import('../src/api/desktop.js')

test('native desktop API sends provider-neutral paths through the Tauri transport', async () => {
  const fileRef = { providerId: 'local', path: '/tmp/Папка with spaces/file.txt' }
  for (const [name, action] of [['open', 'open'], ['openWith', 'open-with'], ['reveal', 'reveal']]) {
    assert.deepEqual(await desktop[name](fileRef), { ok: true })
    assert.deepEqual(calls.at(-1), {
      command: 'desktop_operate',
      args: { payload: { action, filesystemId: 'local', path: fileRef.path } },
    })
  }
  assert.equal(desktop.available, true)
})

test('native desktop API rejects remote and missing paths before invoke', async () => {
  const count = calls.length
  assert.equal((await desktop.open({ providerId: 'sftp:demo', path: '/a.txt' })).error.code, 'ENOTSUPPORTED')
  assert.equal((await desktop.reveal({ providerId: 'local', path: '' })).error.code, 'EINVAL')
  assert.equal(calls.length, count)
})
