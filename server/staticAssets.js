import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { getAsset, isSea } from 'node:sea'

let manifestPromise = null

const getAssetBuffer = async (assetKey) => {
  if (isSea()) {
    return Buffer.from(getAsset(assetKey))
  }

  const relativePath = assetKey.replace(/^web\//, '')
  return fs.readFile(path.join(process.env.VESPERWIND_WEB_ASSETS_DIR, relativePath))
}

const getManifest = async () => {
  if (!manifestPromise) {
    manifestPromise = getAssetBuffer('web/manifest.json').then((content) =>
      JSON.parse(content.toString('utf8')),
    )
  }

  return manifestPromise
}

const getRequestPath = (requestUrl) => {
  try {
    return decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname)
  } catch {
    return null
  }
}

export const serveStaticAsset = async (request, response) => {
  if (
    process.env.NODE_ENV !== 'production' ||
    !['GET', 'HEAD'].includes(request.method)
  ) {
    return false
  }

  const requestPath = getRequestPath(request.url)

  if (!requestPath) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Bad request')
    return true
  }

  const manifest = await getManifest()
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath
  const asset = manifest.files[normalizedPath] ||
    (!path.posix.extname(normalizedPath) ? manifest.files['/index.html'] : null)

  if (!asset) {
    return false
  }

  const content = await getAssetBuffer(asset.key)
  const headers = {
    'content-type': asset.contentType,
    'content-length': content.byteLength,
    'cache-control': asset.immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  }

  response.writeHead(200, headers)
  response.end(request.method === 'HEAD' ? undefined : content)
  return true
}
