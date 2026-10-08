// This is presentation of native local metadata. It never prepares file content.
export const getContentAvailabilityBadge = (entry, providerId = 'local') => {
  if (providerId !== 'local') return null
  const availability = entry?.contentAvailability
  switch (availability?.state) {
    case 'cloud':
      return { icon: 'mdi-cloud-download-outline', label: 'Stored in iCloud — download required' }
    case 'materializing': {
      const progress = availability.progress
      const percentage = typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 1
        ? ` — ${Math.round(progress * 100)}%` : ''
      return { icon: 'mdi-cloud-sync-outline', label: `Downloading from iCloud${percentage}` }
    }
    case 'failed':
      return { icon: 'mdi-cloud-alert-outline', label: 'Unable to determine or download iCloud content' }
    default:
      return null
  }
}
