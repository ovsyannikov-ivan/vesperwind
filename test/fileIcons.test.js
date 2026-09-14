import assert from 'node:assert/strict'
import test from 'node:test'
import { getFileIcon } from '../src/utils/fileIcons.js'

const fileNode = (name) => ({
  name,
  isDirectory: false,
  isSymbolicLink: false,
})

test('uses language-specific icons for JavaScript and Python', () => {
  assert.equal(getFileIcon(fileNode('app.js')).icon, 'mdi-language-javascript')
  assert.equal(getFileIcon(fileNode('worker.py')).icon, 'mdi-language-python')
})

test('uses media icons for playable and icon-only formats', () => {
  assert.equal(getFileIcon(fileNode('clip.mp4')).icon, 'mdi-file-video-outline')
  assert.equal(getFileIcon(fileNode('archive.mkv')).icon, 'mdi-file-video-outline')
  assert.equal(getFileIcon(fileNode('song.mp3')).icon, 'mdi-file-music-outline')
  assert.equal(getFileIcon(fileNode('voice.aac')).icon, 'mdi-file-music-outline')
})
