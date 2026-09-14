import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTerminalAnsiNormalizer,
  normalizeTerminalAnsi,
} from '../src/utils/terminalAnsi.js'

test('maps the macOS dataless-file style to the themed grey palette slot', () => {
  const source = '\x1b[1m\x1b[40mcloud-file.pdf\x1b[39;49m\x1b[0m'
  const normalized = normalizeTerminalAnsi(source)

  assert.equal(
    normalized,
    '\x1b[22;39;100mcloud-file.pdf\x1b[39;49m\x1b[0m',
  )
})

test('does not alter unrelated ANSI colors', () => {
  const source = '\x1b[1m\x1b[34mDocuments\x1b[39m\x1b[0m'

  assert.equal(normalizeTerminalAnsi(source), source)
})

test('normalizes a dataless style split across terminal output chunks', () => {
  const normalizeChunk = createTerminalAnsiNormalizer()

  assert.equal(normalizeChunk('before\x1b[1m'), 'before')
  assert.equal(
    normalizeChunk('\x1b[40mcloud-file.pdf'),
    '\x1b[22;39;100mcloud-file.pdf',
  )
})
