import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-media-'))
const mediaPath = path.join(fixtureRoot, 'sample.mp3')
const pdfPath = path.join(fixtureRoot, 'manual.pdf')
const unsupportedPath = path.join(fixtureRoot, 'sample.mkv')
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

const requestMedia = async (requestedPath, headers = {}) => {
  const response = new MemoryResponse()
  const finished = new Promise((resolve) => response.once('finish', resolve))
  await serveMedia(
    {
      method: 'GET',
      url: `/api/media?path=${encodeURIComponent(requestedPath)}`,
      headers,
    },
    response,
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
