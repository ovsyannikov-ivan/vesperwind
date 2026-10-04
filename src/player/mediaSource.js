// Logical identities never contain a temporary transport URL or native session.
export const normalizeMediaSource = (source) => {
  if (source?.sourceType && !['provider', 'url'].includes(source.sourceType)) throw new Error('Unsupported media source')
  if (source?.sourceType === 'url') {
    let url
    try { url = new URL(String(source.url || '').trim()) } catch { throw new Error('Enter a valid HTTP or HTTPS URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported')
    return { sourceType: 'url', url: url.href }
  }
  if (typeof source?.path !== 'string' || !source.path) throw new Error('A provider path is required')
  return { sourceType: 'provider', providerId: source.providerId || 'local', path: source.path }
}
export const mediaIdentity = (source) => {
  const value = normalizeMediaSource(source)
  return value.sourceType === 'url' ? JSON.stringify(['url', value.url]) : JSON.stringify([value.providerId, value.path])
}
export const mediaSourceLabel = (source) => {
  if (source.sourceType !== 'url') return source.name || source.path?.split(/[\\/]/).pop() || ''
  const url = new URL(source.url)
  // Credentials and query tokens do not belong in tooltips or diagnostics.
  return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
}
export const trackTitle = (item) => item?.tags?.title || item?.displayName || (item ? mediaSourceLabel(item) : '')
export const trackLabel = (item) => item?.tags?.artist ? `${item.tags.artist} — ${trackTitle(item)}` : trackTitle(item)
