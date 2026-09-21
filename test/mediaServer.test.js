import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-media-'))
const mediaPath = path.join(fixtureRoot, 'sample.mp3')
const pdfPath = path.join(fixtureRoot, 'manual.pdf')
const unsupportedPath = path.join(fixtureRoot, 'sample.bin')
await fs.writeFile(mediaPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
await fs.writeFile(pdfPath, Buffer.from('%PDF-1.7\nvesperwind'))
await fs.writeFile(unsupportedPath, Buffer.from([0, 1, 2]))
process.env.FILE_MANAGER_ROOT = fixtureRoot

const { serveMedia } = await import('../server/media.js')

class MemoryResponse extends Writable {
  constructor() {
    super()
    this.statusCode = null
    this.headers = {}
    this.headersSent = false
    this.chunks = []
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode
    this.headers = headers
    this.headersSent = true
    return this
  }

  get body() {
    return Buffer.concat(this.chunks)
  }
}

const requestMedia = async (
  requestedPath,
  headers = {},
  { method = 'GET', providerId = 'local', openSource } = {},
) => {
  const response = new MemoryResponse()
  const finished = new Promise((resolve) => response.once('finish', resolve))
  const request = Object.assign(new EventEmitter(), {
    method,
    url: `/api/content?path=${encodeURIComponent(requestedPath)}&filesystemId=${encodeURIComponent(providerId)}`,
    headers,
  })
  await serveMedia(
    request,
    response,
    { openSource },
  )
  await finished
  return response
}

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

test('streams media with content type and byte-range support', async () => {
  const response = await requestMedia(mediaPath, { range: 'bytes=2-5' })

  assert.equal(response.statusCode, 206)
  assert.equal(response.headers['content-type'], 'audio/mpeg')
  assert.equal(response.headers['content-range'], 'bytes 2-5/10')
  assert.deepEqual([...response.body], [2, 3, 4, 5])
})

test('streams PDFs through the guarded endpoint with byte-range support', async () => {
  const response = await requestMedia(pdfPath, { range: 'bytes=0-7' })

  assert.equal(response.statusCode, 206)
  assert.equal(response.headers['content-type'], 'application/pdf')
  assert.equal(response.headers['accept-ranges'], 'bytes')
  assert.equal(response.body.toString('utf8'), '%PDF-1.7')
})

test('rejects unsupported media and paths outside the configured root', async () => {
  const unsupportedResponse = await requestMedia(unsupportedPath)
  const outsideResponse = await requestMedia(path.dirname(fixtureRoot))

  assert.equal(unsupportedResponse.statusCode, 415)
  assert.equal(outsideResponse.statusCode, 403)
})

test('routes SFTP content through the same range endpoint beyond 4 GB', async () => {
  const size = 5 * 1024 * 1024 * 1024 + 123
  let requestedRange = null
  const response = await requestMedia(
    '/srv/archive/manual.pdf',
    { range: `bytes=${size - 4}-` },
    {
      providerId: 'sftp:production',
      openSource: async ({ providerId, path: requestedPath }) => {
        assert.equal(providerId, 'sftp:production')
        assert.equal(requestedPath, '/srv/archive/manual.pdf')
        return {
          path: requestedPath,
          size,
          createReadStream: (range) => {
            requestedRange = range
            return Readable.from(Buffer.from('tail'))
          },
        }
      },
    },
  )

  assert.equal(response.statusCode, 206)
  assert.equal(
    response.headers['content-range'],
    `bytes ${size - 4}-${size - 1}/${size}`,
  )
  assert.deepEqual(requestedRange, { start: size - 4, end: size - 1, length: 4 })
  assert.equal(response.body.toString(), 'tail')
})

test('serves provider-neutral metadata with HEAD and no body', async () => {
  let opened = false
  const response = await requestMedia('/remote/photo.jpeg', {}, {
    method: 'HEAD',
    providerId: 'sftp:photos',
    openSource: async () => ({
      path: '/remote/photo.jpeg',
      size: 42,
      createReadStream: () => {
        opened = true
        return Readable.from([])
      },
    }),
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-length'], 42)
  assert.equal(response.headers['content-type'], 'image/jpeg')
  assert.equal(response.body.length, 0)
  assert.equal(opened, false)
})

test('cancels the provider stream when the client aborts', async () => {
  const request = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/api/content?path=%2Fremote%2Fmovie.mp4&filesystemId=sftp%3Avideo',
    headers: {},
  })
  const response = new MemoryResponse()
  const sourceStream = new Readable({ read() {} })

  await serveMedia(request, response, {
    openSource: async () => ({
      path: '/remote/movie.mp4',
      size: 1024,
      createReadStream: () => sourceStream,
    }),
  })
  request.emit('aborted')

  assert.equal(sourceStream.destroyed, true)
  response.destroy()
})
