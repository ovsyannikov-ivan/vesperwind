export const LOCAL_FILESYSTEM_PROVIDER = 'local'

export const filesystemLocation = (
  path,
  providerId = LOCAL_FILESYSTEM_PROVIDER,
) => ({ providerId, path })
