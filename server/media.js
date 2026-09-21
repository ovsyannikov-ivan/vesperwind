import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  canServePreview,
  getMediaContentType,
} from '../shared/mediaTypes.js'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'
import { openSftpContentSource } from './ssh.js'

const createMediaError = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}

export const parseByteRange = (rangeHeader, size) => {
  if (!rangeHeader) {
    return null
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())

  if (!match || size <= 0) {
    throw createMediaError('ERANGE', 'Invalid byte range')
  }

  if (!Number.isSafeInteger(size)) {
    throw createMediaError('EOVERFLOW', 'The content size exceeds the runtime limit')
  }

  const [, startText, endText] = match
  const size64 = BigInt(size)
  let start64
  let end64

  if (!startText) {
    const suffixLength = BigInt(endText)

    if (suffixLength <= 0n) {
      throw createMediaError('ERANGE', 'Invalid byte range')
    }

    start64 = suffixLength >= size64 ? 0n : size64 - suffixLength
    end64 = size64 - 1n
  } else {
    start64 = BigInt(startText)
    end64 = endText ? BigInt(endText) : size64 - 1n

    if (
      start64 < 0n ||
      start64 >= size64 ||
      end64 < start64
    ) {
      throw createMediaError('ERANGE', 'Invalid byte range')
    }

    end64 = end64 < size64 ? end64 : size64 - 1n
  }

  const start = Number(start64)
  const end = Number(end64)

  return {
    start,
    end,
    length: end - start + 1,
  }
}

const statusForError = (error) => {
  if (error?.code === 'ERANGE') {
    return 416
  }

  if (['EOUTSIDE_ROOT', 'EACCES', 'EPERM'].includes(error?.code)) {
    return 403
  }

  if (error?.code === 'ENOENT') {
    return 404
  }

  if (error?.code === 'ESSH_DISCONNECTED') {
    return 503
  }

  if (['EINVAL', 'ENOTFILE', 'EFILESYSTEM_ID', 'EOVERFLOW'].includes(error?.code)) {
    return 400
  }

  if (error?.code === 'EMEDIA_TYPE') {
    return 415
  }

  return 500
}

const writeError = (response, error, size = null, headOnly = false) => {
  const status = statusForError(error)
  const body = Buffer.from(JSON.stringify({
    ok: false,
    error: {
      code: error?.code || 'EMEDIA',
      message: error?.message || 'Unable to open media file',
    },
  }))
  const headers = {
    'accept-ranges': 'bytes',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
  }

  if (status === 416 && Number.isFinite(size)) {
    headers['content-range'] = `bytes */${size}`
  }

  response.writeHead(status, headers)
  response.end(headOnly ? undefined : body)
}

const openLocalContentSource = async (requestedPath) => {
  const resolvedPath = resolveInsideRoot(requestedPath)
  await verifyRealPathInsideRoot(resolvedPath)
  const stats = await fs.stat(resolvedPath)

  if (!stats.isFile()) {
    throw createMediaError('ENOTFILE', 'The requested path is not a file')
  }

  return {
    path: resolvedPath,
    size: stats.size,
    createReadStream: ({ start, end } = {}) =>
      createReadStream(resolvedPath, {
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
      }),
  }
}

export const openContentSource = async (
  { providerId = 'local', path: requestedPath },
  { sshConnections } = {},
) => {
  if (providerId === 'local') {
    return openLocalContentSource(requestedPath)
  }
  if (providerId.startsWith('sftp:')) {
    return openSftpContentSource(sshConnections, providerId, requestedPath)
  }
  throw createMediaError('EFILESYSTEM_ID', 'This filesystem is not available')
}

const pipeSource = (request, response, stream) => {
  const cancel = () => stream.destroy()
  request.once?.('aborted', cancel)
  response.once?.('close', cancel)
  stream.once('error', () => response.destroy())
  stream.once('close', () => {
    request.off?.('aborted', cancel)
    response.off?.('close', cancel)
  })
  stream.pipe(response)
}

export const serveMedia = async (request, response, options = {}) => {
  let requestUrl

  try {
    requestUrl = new URL(request.url, 'http://localhost')
  } catch {
    return false
  }

  if (!['/api/media', '/api/content'].includes(requestUrl.pathname)) {
    return false
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return true
  }

  const requestedPath = requestUrl.searchParams.get('path')
  let fileSize = null

  try {
    if (!requestedPath) {
      throw createMediaError('EINVAL', 'A media file path is required')
    }
    const providerId = requestUrl.searchParams.get('filesystemId') || 'local'
    const source = options.openSource
      ? await options.openSource({ providerId, path: requestedPath })
      : await openContentSource(
          { providerId, path: requestedPath },
          { sshConnections: options.sshConnections },
        )

    if (!canServePreview(path.basename(source.path))) {
      throw createMediaError(
        'EMEDIA_TYPE',
        'This file format is not supported by the built-in viewer',
      )
    }

    fileSize = source.size
    const range = parseByteRange(request.headers.range, source.size)
    const headers = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': getMediaContentType(source.path),
      'x-content-type-options': 'nosniff',
    }

    if (range) {
      headers['content-length'] = range.length
      headers['content-range'] = `bytes ${range.start}-${range.end}/${source.size}`
      response.writeHead(206, headers)

      if (request.method === 'HEAD') {
        response.end()
      } else {
        pipeSource(request, response, source.createReadStream(range))
      }

      return true
    }

    headers['content-length'] = source.size
    response.writeHead(200, headers)

    if (request.method === 'HEAD') {
      response.end()
    } else {
      pipeSource(request, response, source.createReadStream())
    }
  } catch (error) {
    if (!response.headersSent) {
      writeError(response, error, fileSize, request.method === 'HEAD')
    } else {
      response.destroy()
    }
  }

  return true
}
