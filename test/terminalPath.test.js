import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTerminalPath } from '../src/utils/terminalPath.js'

test('shortens home paths and keeps simple paths readable', () => {
  assert.equal(
    formatTerminalPath('/Users/ivan/Documents', {
      homePath: '/Users/ivan',
      directory: true,
    }),
    '~/Documents/',
  )
  assert.equal(
    formatTerminalPath('/Users/ivan/Documents/report.pdf', {
      homePath: '/Users/ivan',
    }),
    '~/Documents/report.pdf',
  )
})

test('quotes shell-sensitive path segments without quoting the home shortcut', () => {
  assert.equal(
    formatTerminalPath('/Users/ivan/My Documents/annual report.pdf', {
      homePath: '/Users/ivan',
    }),
    "~/'My Documents/annual report.pdf'",
  )
  assert.equal(
    formatTerminalPath("/Users/ivan/John's files", {
      homePath: '/Users/ivan',
      directory: true,
    }),
    "~/'John'\\''s files/'",
  )
})

test('keeps absolute paths outside home and ignores invalid values', () => {
  assert.equal(
    formatTerminalPath('/tmp/example.txt', { homePath: '/Users/ivan' }),
    '/tmp/example.txt',
  )
  assert.equal(formatTerminalPath('', { homePath: '/Users/ivan' }), '')
  assert.equal(formatTerminalPath(null, { homePath: '/Users/ivan' }), '')
})
