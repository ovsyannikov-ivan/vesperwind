import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getEntryOpenAction,
  getFileOpenType,
  isMediaOpenType,
  isWorkspaceDocumentType,
} from '../src/utils/fileTypes.js'

const editableFiles = ['.vue', '.txt', '.pdf']

test('resolves files to a single built-in opening strategy', () => {
  assert.equal(getFileOpenType('App.vue', editableFiles), 'text')
  assert.equal(getFileOpenType('manual.PDF', editableFiles), 'pdf')
  assert.equal(getFileOpenType('photo.jpg', editableFiles), 'image')
  assert.equal(getFileOpenType('clip.mp4', editableFiles), 'video')
  assert.equal(getFileOpenType('voice.mp3', editableFiles), 'audio')
  assert.equal(getFileOpenType('archive.zip', editableFiles), null)
})

test('keeps PDF out of Monaco even when it appears in editable settings', () => {
  assert.equal(getFileOpenType('report.pdf', editableFiles), 'pdf')
  assert.equal(isWorkspaceDocumentType('pdf'), true)
  assert.equal(isWorkspaceDocumentType('text'), true)
  assert.equal(isMediaOpenType('pdf'), false)
})

test('derives context-menu actions from the shared opening strategy', () => {
  assert.equal(getEntryOpenAction({ name: 'src', isDirectory: true }, editableFiles), 'open')
  assert.equal(getEntryOpenAction({ name: 'App.vue' }, editableFiles), 'edit')
  assert.equal(getEntryOpenAction({ name: 'manual.pdf' }, editableFiles), 'view')
  assert.equal(getEntryOpenAction({ name: 'archive.zip' }, editableFiles), null)
})
