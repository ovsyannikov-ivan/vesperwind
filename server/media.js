import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  canServePreview,
  getMediaContentType,
} from '../shared/mediaTypes.js'
import { resolveInsideRoot, verifyRealPathInsideRoot } from './filesystem.js'

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

  const [, startText, endText] = match
  let start
  let end

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10)

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      throw createMediaError('ERANGE', 'Invalid byte range')
    }

    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number.parseInt(startText, 10)
    end = endText ? Number.parseInt(endText, 10) : size - 1

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      throw createMediaError('ERANGE', 'Invalid byte range')
    }

    end = Math.min(end, size - 1)
  }

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

  if (['EINVAL', 'ENOTFILE'].includes(error?.code)) {
    return 400
  }

  if (error?.code === 'EMEDIA_TYPE') {
    return 415
  }

  return 500
}

const writeError = (response, error, size = null) => {
  const status = statusForError(error)
  const headers = { 'content-type': 'application/json; charset=utf-8' }

  if (status === 416 && Number.isFinite(size)) {
    headers['content-range'] = `bytes */${size}`
  }

  response.writeHead(status, headers)
  response.end(
    JSON.stringify({
      ok: false,
      error: {
        code: error?.code || 'EMEDIA',
        message: error?.message || 'Unable to open media file',
      },
    }),
  )
}

export const serveMedia = async (request, response) => {
  let requestUrl

  try {
    requestUrl = new URL(request.url, 'http://localhost')
  } catch {
    return false
  }

  if (requestUrl.pathname !== '/api/media') {
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

    const resolvedPath = resolveInsideRoot(requestedPath)
    await verifyRealPathInsideRoot(resolvedPath)
    const stats = await fs.stat(resolvedPath)

    if (!stats.isFile()) {
      throw createMediaError('ENOTFILE', 'The requested path is not a file')
    }

    if (!canServePreview(path.basename(resolvedPath))) {
      throw createMediaError(
        'EMEDIA_TYPE',
        'This file format is not supported by the built-in viewer',
      )
    }

    fileSize = stats.size
    const range = parseByteRange(request.headers.range, stats.size)
    const headers = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': getMediaContentType(resolvedPath),
      'x-content-type-options': 'nosniff',
    }

    if (range) {
      headers['content-length'] = range.length
      headers['content-range'] = `bytes ${range.start}-${range.end}/${stats.size}`
      response.writeHead(206, headers)

      if (request.method === 'HEAD') {
        response.end()
      } else {
        const stream = createReadStream(resolvedPath, {
          start: range.start,
          end: range.end,
        })
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      }

      return true
    }

    headers['content-length'] = stats.size
    response.writeHead(200, headers)

    if (request.method === 'HEAD') {
      response.end()
    } else {
      const stream = createReadStream(resolvedPath)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    }
  } catch (error) {
    if (!response.headersSent) {
      writeError(response, error, fileSize)
    } else {
      response.destroy()
    }
  }

  return true
}
