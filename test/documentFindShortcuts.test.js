import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_FIND_INTENTS,
  getDocumentFindIntent,
} from '../src/utils/documentFindShortcuts.js'

const keyEvent = (key, modifiers = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
})

test('routes macOS document find shortcuts', () => {
  assert.equal(
    getDocumentFindIntent(keyEvent('f', { metaKey: true }), true),
    DOCUMENT_FIND_INTENTS.OPEN,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('f', { metaKey: true, altKey: true }), true),
    DOCUMENT_FIND_INTENTS.OPEN_REPLACE,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('g', { metaKey: true }), true),
    DOCUMENT_FIND_INTENTS.NEXT,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('g', { metaKey: true, shiftKey: true }), true),
    DOCUMENT_FIND_INTENTS.PREVIOUS,
  )
})

test('routes Windows and Linux document find shortcuts', () => {
  assert.equal(
    getDocumentFindIntent(keyEvent('f', { ctrlKey: true }), false),
    DOCUMENT_FIND_INTENTS.OPEN,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('h', { ctrlKey: true }), false),
    DOCUMENT_FIND_INTENTS.OPEN_REPLACE,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('F3'), false),
    DOCUMENT_FIND_INTENTS.NEXT,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('F3', { shiftKey: true }), false),
    DOCUMENT_FIND_INTENTS.PREVIOUS,
  )
})

test('routes Escape without stealing unrelated global shortcuts', () => {
  assert.equal(
    getDocumentFindIntent(keyEvent('Escape'), true),
    DOCUMENT_FIND_INTENTS.CLOSE,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('f', { ctrlKey: true }), true),
    null,
  )
  assert.equal(
    getDocumentFindIntent(keyEvent('p', { metaKey: true }), true),
    null,
  )
})
