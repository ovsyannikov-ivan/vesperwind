import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canPreviewMedia,
  canServePreview,
  getMediaContentType,
  getMediaKind,
} from '../shared/mediaTypes.js'
import { parseByteRange } from '../server/media.js'

test('classifies common browser media and icon-only video formats', () => {
  assert.equal(getMediaKind('clip.MP4'), 'video')
  assert.equal(getMediaKind('archive.mkv'), 'video')
  assert.equal(getMediaKind('recording.m4a'), 'audio')
  assert.equal(getMediaKind('voice.aac'), 'audio')
  assert.equal(getMediaKind('photo.JPEG'), 'image')
  assert.equal(getMediaKind('notes.txt'), null)
  assert.equal(canPreviewMedia('clip.mov'), true)
  assert.equal(canPreviewMedia('archive.mkv'), false)
  assert.equal(canPreviewMedia('photo.png'), true)
  assert.equal(canPreviewMedia('manual.pdf'), false)
  assert.equal(canServePreview('manual.PDF'), true)
})

test('returns explicit media content types', () => {
  assert.equal(getMediaContentType('clip.m4v'), 'video/x-m4v')
  assert.equal(getMediaContentType('voice.mp3'), 'audio/mpeg')
  assert.equal(getMediaContentType('sound.flac'), 'audio/flac')
  assert.equal(getMediaContentType('photo.jpeg'), 'image/jpeg')
  assert.equal(getMediaContentType('manual.PDF'), 'application/pdf')
})

test('parses open, closed, and suffix byte ranges', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), {
    start: 10,
    end: 19,
    length: 10,
  })
  assert.deepEqual(parseByteRange('bytes=90-', 100), {
    start: 90,
    end: 99,
    length: 10,
  })
  assert.deepEqual(parseByteRange('bytes=-8', 100), {
    start: 92,
    end: 99,
    length: 8,
  })
  assert.equal(parseByteRange(undefined, 100), null)
})

test('rejects unsatisfiable and multiple ranges', () => {
  assert.throws(() => parseByteRange('bytes=100-110', 100), {
    code: 'ERANGE',
  })
  assert.throws(() => parseByteRange('bytes=0-1,3-4', 100), {
    code: 'ERANGE',
  })
})
