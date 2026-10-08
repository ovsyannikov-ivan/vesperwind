import assert from 'node:assert/strict'
import test from 'node:test'
import { addressLocation, createAddressNavigation, isAddressShortcut } from '../src/utils/addressNavigation.js'
test('address navigation preserves provider identity for POSIX, drives and UNC', () => {
  assert.deepEqual(addressLocation('/home/me/', { providerId: 'sftp:a' }), { providerId: 'sftp:a', path: '/home/me' })
  for (const path of ['C:\\folder', '\\\\server\\share', 'smb://server/share', 'computer://']) assert.deepEqual(addressLocation(path, { providerId: 'local' }), { providerId: 'local', path })
  assert.throws(() => addressLocation('smb://server/share', { providerId: 'sftp:a' }))
  assert.throws(() => addressLocation('relative', { providerId: 'local' }))
  assert.ok(isAddressShortcut({ key: 'L', metaKey: true }))
  assert.ok(!isAddressShortcut({ key: 'l', ctrlKey: true, altKey: true }))
})
const fixture = (resolve) => {
  const state = {}, locations = [], current = { providerId: 'local', path: '/old' }
  const navigation = createAddressNavigation({ state, getLocation: () => current, resolve, navigate: (location) => locations.push(location) })
  return { state, locations, current, navigation }
}
test('Enter navigates only after validation; errors retain folder and draft', async () => {
  const f = fixture(async () => ({ ok: false, error: { message: 'Denied' } }))
  f.navigation.edit(); f.state.draft = '/private'; await f.navigation.submit()
  assert.equal(f.state.editing, true); assert.equal(f.state.draft, '/private'); assert.equal(f.state.error, 'Denied'); assert.equal(f.locations.length, 0)
  const success = fixture(async (location) => ({ ok: true, location }))
  success.navigation.edit(); success.state.draft = '/new'; await success.navigation.submit()
  assert.equal(success.state.editing, false); assert.deepEqual(success.locations, [{ providerId: 'local', path: '/new' }])
})
test('Escape, provider change and disposal suppress stale navigation', async () => {
  for (const action of ['cancel', 'dispose', 'provider']) {
    let complete
    const f = fixture(() => new Promise((resolve) => { complete = resolve }))
    f.navigation.edit(); f.state.draft = '/new'; const pending = f.navigation.submit()
    if (action === 'provider') { f.current.providerId = 'sftp:b'; f.navigation.cancel() } else f.navigation[action]()
    complete({ ok: true, location: { providerId: 'local', path: '/new' } }); await pending
    assert.equal(f.locations.length, 0); assert.equal(f.state.busy, false)
  }
})

test('the panel path field has confirm and cancel buttons inside it', async () => {
  const { readFile } = await import('node:fs/promises')
  const panel = await readFile(new URL('../src/components/FilePanel.vue', import.meta.url), 'utf8')
  const form = panel.match(/<form v-else-if="address\.editing" class="panel-address-form"[\s\S]*?<\/form>/u)[0]
  assert.match(form, /@submit\.prevent="addressNavigation\.submit"/u)
  assert.match(form, /type="submit"[\s\S]*?mdi-check/u)
  assert.match(form, /type="button"[\s\S]*?@click="addressNavigation\.cancel"[\s\S]*?mdi-close/u)
})

test('long breadcrumbs cannot shrink the provider badge; longer remote labels retain their width cap', async () => {
  const { compiledStyles } = await import('./support/styles.js')
  const css = compiledStyles('src/styles/main.scss')
  const providerBadge = css.match(/\.panel-provider-label\s*\{[^}]*\}/u)?.[0]
  assert.ok(providerBadge)
  assert.match(providerBadge, /flex: 0 0 auto;/u)
  assert.match(providerBadge, /max-width: 130px;/u)
  assert.match(providerBadge, /text-overflow: ellipsis;/u)
  const { readFile } = await import('node:fs/promises')
  const panel = await readFile(new URL('../src/components/FilePanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /class="badge text-bg-secondary panel-provider-label" :title="providerLabel"/u)
})

test('every text field and select draws its focus inside the border', async () => {
  const { compiledStyles } = await import('./support/styles.js')
  const css = compiledStyles('src/styles/main.scss')
  assert.match(css, /\.form-control:focus,\s*\.form-select:focus \{\s*border-color: var\(--bs-primary\);\s*box-shadow: inset 0 0 0 1px var\(--bs-primary\);/u)
  assert.match(css, /\.form-control\.is-invalid:focus,\s*\.form-select\.is-invalid:focus \{[^}]*box-shadow: inset 0 0 0 1px/u)
})
