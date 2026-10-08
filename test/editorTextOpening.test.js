import test from 'node:test'
import assert from 'node:assert/strict'
import { openTextDocument } from '../src/editor/openTextDocument.js'
import { getDocumentHandler } from '../src/editor/documentHandlers.js'

test('TypeScript uses the existing provider-aware strict text read; other source files keep their options', async () => {
  const reads = [], handler = getDocumentHandler('text')
  for (const fileName of ['remote.ts', 'remote.js']) {
    const tab = handler.createTab({ id: fileName, fileName, filePath: `/home/user/${fileName}`, filesystemId: 'sftp:qa' })
    await handler.load(tab, { readTextFile: async (...args) => { reads.push(args); return { ok: true, content: 'export const answer=42' } } })
    assert.equal(tab.content, 'export const answer=42')
  }
  assert.equal(reads[0][1], 'sftp:qa')
  assert.equal(reads[0][2].strictText, true)
  assert.equal(reads[1][2].strictText, undefined)
})

test('only an open binary .ts tab falls back to video; close, text, size and read errors never trigger it', async () => {
  for (const scenario of [
    { name: 'video.ts', code: 'ETEXT_BINARY', open: true, fallback: true },
    { name: 'source.ts', open: true },
    { name: 'closed.ts', code: 'ETEXT_BINARY', open: false },
    { name: 'large.ts', code: 'EFILE_TOO_LARGE', open: true },
    { name: 'denied.ts', code: 'EACCES', open: true },
    { name: 'source.js', code: 'ETEXT_BINARY', open: true },
  ]) {
    const calls = [], tab = { id: 'tab', error: scenario.code ? { code: scenario.code } : null }
    const context = { node: { name: scenario.name, path: `/qa/${scenario.name}` }, filesystemId: 'sftp:qa', type: 'text' }
    const output = await openTextDocument(context, { openText: async () => tab,
      isOpen: () => scenario.open, closeText: id => calls.push(['close', id]),
      onVideo: () => calls.push(['mode']), openVideo: value => calls.push(['video', value]) })
    assert.equal(output, tab)
    assert.equal(calls.length, scenario.fallback ? 3 : 0, scenario.name)
    if (scenario.fallback) assert.deepEqual(calls[2], ['video', { ...context, type: 'video' }])
  }
})
