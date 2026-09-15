import { LOCAL_FILESYSTEM_PROVIDER } from './filesystemLocation.js'

const getUrl = ({ path, providerId = LOCAL_FILESYSTEM_PROVIDER } = {}) => {
  let url = `/api/media?path=${encodeURIComponent(path || '')}`

  if (providerId !== LOCAL_FILESYSTEM_PROVIDER) {
    url += `&filesystemId=${encodeURIComponent(providerId)}`
  }

  return url
}

export const media = Object.freeze({ getUrl })
