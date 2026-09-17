import test from 'node:test'
import assert from 'node:assert/strict'
import { relocatePath } from '../src/composables/useEntryChanges.js'
import { entryNameError } from '../shared/entryName.js'

test('rename relocates an entry and descendants, not similarly named siblings', () => {
  const change = { action: 'rename', sourcePath: '/work/a', destinationPath: '/work/b' }
  assert.equal(relocatePath('/work/a', change), '/work/b')
  assert.equal(relocatePath('/work/a/nested/file.txt', change), '/work/b/nested/file.txt')
  assert.equal(relocatePath('/work/another/file.txt', change), '/work/another/file.txt')
  assert.equal(relocatePath(null, change), null)
  assert.equal(relocatePath('/work/a', { action: 'create-file' }), '/work/a')
})

test('rename relocation understands Windows path separators', () => {
  const change = {
    action: 'rename',
    sourcePath: 'C:\\Work\\a',
    destinationPath: 'C:\\Work\\b',
  }

  assert.equal(
    relocatePath('C:\\Work\\a\\nested\\file.txt', change),
    'C:\\Work\\b\\nested\\file.txt',
  )
  assert.equal(
    relocatePath('C:\\Work\\another\\file.txt', change),
    'C:\\Work\\another\\file.txt',
  )
})

test('entry names permit Unicode, spaces and dotfiles but reject path components', () => {
  for (const name of ['Отчёт.txt', 'my folder', '.gitignore', ' file ']) {
    assert.equal(entryNameError(name), '')
  }
  for (const name of ['', ' ', '.', '..', '../a', 'a/b', 'a\\b', 'a\0b', 'a\nb']) {
    assert.notEqual(entryNameError(name), '')
  }
})
