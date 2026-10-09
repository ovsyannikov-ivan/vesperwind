export const archiveName = (name) => /\.(zip|tar|tar\.gz|tgz|rar|7z)$/iu.test(name || '')
export const extractionFolderName = (name) => String(name || '').replace(/\.(tar\.gz|tgz|zip|tar|rar|7z)$/iu, '') || 'Extracted'
export const validArchiveDestinationName = (name) => typeof name === 'string' &&
  Boolean(name.trim()) && name === name.trim() && name !== '.' && name !== '..' &&
  !/[\\/:\x00-\x1f\x7f]/u.test(name) && !/[. ]$/u.test(name) &&
  !/^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)

export const validateArchiveRequest = (request) => {
  if (!['create', 'extract'].includes(request?.action) || !validArchiveDestinationName(request?.name)) {
    return { code: 'EINVAL', message: 'Choose a valid archive or destination folder name' }
  }
  if (request.target?.providerId !== 'local' || !request.target.path ||
      !Array.isArray(request.sources) || !request.sources.length || request.sources.length > 1000 ||
      request.sources.some((source) => source?.providerId !== 'local' || !source.path)) {
    return { code: 'ENOTSUPPORTED', message: 'Archives require local files and folders, including mounted network shares' }
  }
  if (request.action === 'extract' && request.sources.length !== 1) return { code: 'EINVAL', message: 'Select one archive to extract' }
  if (request.action === 'create' && !request.name.toLowerCase().endsWith('.zip')) return { code: 'EINVAL', message: 'The archive name must end in .zip' }
  return null
}
