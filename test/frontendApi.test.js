import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  filesystemLocation,
  LOCAL_FILESYSTEM_PROVIDER,
} from '../src/api/filesystemLocation.js'
import { media } from '../src/api/media.js'
import { normalizeApiResponse } from '../src/api/response.js'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const sourceFilesIn = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        return sourceFilesIn(entryPath)
      }

      return /\.(?:js|vue)$/.test(entry.name) ? [entryPath] : []
    }),
  )

  return files.flat()
}

test('keeps Vue components and composables behind the frontend API boundary', async () => {
  const directories = ['components', 'composables'].map((directory) =>
    path.join(projectRoot, 'src', directory),
  )
  const files = (await Promise.all(directories.map(sourceFilesIn))).flat()
  const backendDetails = [
    /socket\.io-client/,
    /socket\.(?:emit|on|off|once|timeout)/,
    /["'`]\/api\/media/,
    /(?:filesystem|settings|terminal):[a-z-]+/,
  ]

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')

    for (const pattern of backendDetails) {
      assert.doesNotMatch(
        source,
        pattern,
        `${path.relative(projectRoot, file)} bypasses src/api`,
      )
    }
  }
})

test('models filesystem targets independently from the current transport', () => {
  assert.deepEqual(filesystemLocation('/tmp/example.txt'), {
    providerId: LOCAL_FILESYSTEM_PROVIDER,
    path: '/tmp/example.txt',
  })
  assert.deepEqual(filesystemLocation('/srv/example.txt', 'ssh:server'), {
    providerId: 'ssh:server',
    path: '/srv/example.txt',
  })
})

test('builds media sources behind the media API', () => {
  assert.equal(
    media.getUrl({ path: '/tmp/My file.pdf' }),
    '/api/media?path=%2Ftmp%2FMy%20file.pdf',
  )
  assert.equal(
    media.getUrl({ providerId: 'ssh:server', path: '/srv/video.mp4' }),
    '/api/media?path=%2Fsrv%2Fvideo.mp4&filesystemId=ssh%3Aserver',
  )
})

test('normalizes malformed backend failures at the API boundary', () => {
  assert.deepEqual(
    normalizeApiResponse(undefined, 'EFALLBACK', 'Fallback message'),
    {
      ok: false,
      error: {
        code: 'EFALLBACK',
        message: 'Fallback message',
      },
    },
  )
})
