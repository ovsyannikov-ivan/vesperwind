import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { ref, computed, watch } from 'vue'
import { createDefaultSettings, normalizeSettings } from '../shared/defaultSettings.js'

const composable = (await fs.readFile(new URL('../src/composables/usePermissionSetup.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace('export const usePermissionSetup', 'const usePermissionSetup')
const fixture = ({ supported = true, complete = false, saveFails = false } = {}) => {
  const settings = ref(createDefaultSettings()); settings.value.permissions.setupCompleted = complete
  const saved = []
  const deps = { ref, permissionsApi: { capabilities: async () => ({ ok: true, supported }) }, useSettings: () => ({ settings,
    loadSettings: async () => ({ ok: true }), saveSettings: async value => { saved.push(value); return saveFails ? { ok: false, error: { message: 'Save failed' } } : { ok: true } } }) }
  const setup = vm.compileFunction(`${composable}\nreturn usePermissionSetup()`, Object.keys(deps))(...Object.values(deps))
  return { setup, saved }
}
test('first launch gates file panels until setup is finished or skipped; subsequent launches do not gate', async () => {
  const f = fixture(); await f.setup.initialize()
  assert.equal(f.setup.open.value, true); assert.equal(f.setup.ready.value, false)
  await f.setup.finish(); assert.equal(f.setup.ready.value, true); assert.equal(f.setup.open.value, false)
  assert.equal(f.saved[0].permissions.setupCompleted, true)
  const existing = fixture({ complete: true }); await existing.setup.initialize()
  assert.equal(existing.setup.ready.value, true); assert.equal(existing.setup.open.value, false)
  existing.setup.show(); assert.equal(existing.setup.ready.value, true, 'reopening must preserve mounted editor/undo history')
  assert.equal(existing.setup.open.value, true)
})
test('browser/Windows do not show setup; persistence failure is retryable; only completion is stored', async () => {
  const other = fixture({ supported: false }); await other.setup.initialize()
  assert.equal(other.setup.ready.value, true); assert.equal(other.setup.open.value, false)
  const failing = fixture({ saveFails: true }); await failing.setup.initialize(); await failing.setup.finish()
  assert.equal(failing.setup.ready.value, false); assert.equal(failing.setup.open.value, true)
  assert.deepEqual(normalizeSettings({ permissions: { setupCompleted: 'true', networkGranted: true } }).permissions, { setupCompleted: false })
})

const modal = (await fs.readFile(new URL('../src/components/PermissionSetupModal.vue', import.meta.url), 'utf8')).split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm, '')
test('skipping a waiting step cancels it and ignores a late permission result', async () => {
  let reply, signal
  const deps = { ref, computed, watch, onMounted() {}, onBeforeUnmount() {}, defineProps: () => ({ open: false }),
    usePermissionSetup: () => ({ finish: async () => ({ ok: true }) }),
    permissionsApi: { request: (_kind, options) => { signal = options.signal; return new Promise(resolve => { reply = resolve }) } } }
  const f = vm.compileFunction(`${modal}\nreturn { request, next, step, busy, results }`, Object.keys(deps))(...Object.values(deps))
  const waiting = f.request(); assert.equal(f.busy.value, true)
  f.next(); assert.equal(signal.aborted, true); assert.equal(f.step.value, 1)
  reply({ ok: true }); await waiting
  assert.equal(f.results.value.desktop, undefined)
  assert.equal(f.busy.value, false)
})
