import { normalizeFilesystemPath } from './filesystemPath.js'
export const addressLocation = (address, current) => {
  const value = String(address || '').trim()
  if (!value || value.includes('\0')) throw new Error('Enter a folder path')
  const network = /^smb:\/\//iu.test(value)
  const windows = /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value)
  if (current?.providerId !== 'local' && (network || windows)) throw new Error('Use an absolute path on the current SFTP server')
  if (!(network || windows || value.startsWith('/') || (current?.providerId === 'local' && value === 'computer://'))) throw new Error('Enter an absolute folder path')
  return { providerId: current.providerId, path: network ? value : normalizeFilesystemPath(value) }
}
export const isAddressShortcut = (event) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l'
export const createAddressNavigation = ({ state, getLocation, resolve, navigate }) => {
  let sequence = 0
  const cancel = () => { sequence++; state.editing = false; state.busy = false; state.error = '' }
  const edit = () => { sequence++; state.editing = true; state.busy = false; state.error = ''; state.draft = getLocation()?.path || '' }
  const submit = async () => {
    if (state.busy) return
    const id = ++sequence, current = { ...getLocation() }
    state.error = ''; state.busy = true
    try {
      const response = await resolve(addressLocation(state.draft, current))
      if (id !== sequence || getLocation()?.providerId !== current.providerId || getLocation()?.path !== current.path) return
      if (!response?.ok) { state.error = response?.error?.message || 'Unable to open this folder'; return }
      state.editing = false; navigate(response.location)
    } catch (error) { if (id === sequence) state.error = error.message || 'Unable to open this folder' }
    finally { if (id === sequence) state.busy = false }
  }
  return { edit, cancel, submit, dispose: cancel }
}
