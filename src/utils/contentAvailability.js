// This is presentation of native local metadata. It never prepares file content.
export const getContentAvailabilityBadge = (entry, providerId = 'local') => {
  if (providerId !== 'local') return null
  const availability = entry?.contentAvailability
  if (availability?.provider && !['onedrive', 'icloud'].includes(availability.provider)) return null
  const provider = availability?.provider === 'onedrive' ? 'OneDrive' : 'iCloud'
  switch (availability?.state) {
    case 'cloud':
      return { icon: 'mdi-cloud-download-outline', label: `Stored in ${provider} — download required` }
    case 'materializing': {
      const progress = availability.progress
      const percentage = typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 1
        ? ` — ${Math.round(progress * 100)}%` : ''
      return { icon: 'mdi-cloud-sync-outline', label: `Downloading from ${provider}${percentage}` }
    }
    case 'failed':
      return { icon: 'mdi-cloud-alert-outline', label: `Unable to determine or download ${provider} content` }
    case 'notReady':
      return availability.provider === 'onedrive'
        ? { icon: 'mdi-cloud-clock-outline', label: 'OneDrive content is not ready for reading' } : null
    default:
      return null
  }
}

// One compact status symbol. Windows availability/pinning determines its
// Explorer-like appearance; IN_SYNC remains an independent fact in the tooltip.
export const getFileStatusBadge = (entry, providerId = 'local') => {
  if (providerId !== 'local') return null
  const availability = entry?.contentAvailability
  const sync = entry?.cloudSync
  if (availability?.provider !== 'onedrive' && sync?.provider !== 'onedrive') {
    return getContentAvailabilityBadge(entry, providerId)
  }
  const syncText = sync?.inspection === 'ok' && sync.state === 'inSync'
    ? 'OneDrive reports this file as synchronized'
    : sync?.inspection === 'ok' && sync.state === 'notInSync'
      ? 'OneDrive has not marked this file as synchronized' : 'OneDrive synchronization status is unknown'
  const badge = (icon, state, label) => ({ icon, className: `is-onedrive is-${state}`, label: `${label} — ${syncText}` })
  switch (availability?.state) {
    case 'failed': return badge('mdi-alert-circle-outline', 'error', 'Unable to determine or download OneDrive content')
    case 'materializing': return badge('mdi-sync', 'pending', getContentAvailabilityBadge(entry, providerId).label)
    case 'cloud': return badge('mdi-cloud-outline', 'online', 'OneDrive content is not fully available locally; download required')
    case 'notReady': return badge('mdi-clock-outline', 'pending', 'OneDrive content is not ready for reading')
  }
  if (sync?.inspection === 'error') return badge('mdi-alert-circle-outline', 'error', 'Unable to determine OneDrive file status')
  if (sync?.inspection !== 'ok') return null
  if (sync.localContent === 'notFullyLocal') return badge('mdi-cloud-outline', 'online', 'OneDrive content is not fully available locally; download required')
  if (sync.localContent !== 'present') return null
  if (sync.state !== 'inSync') return badge('mdi-clock-outline', 'pending', 'OneDrive content is locally available')
  if (sync.pinPolicy === 'pinned') return badge('mdi-check-circle', 'pinned', 'Always keep on this device; content is locally available')
  return badge('mdi-check-circle-outline', 'local', 'OneDrive content is locally available')
}
