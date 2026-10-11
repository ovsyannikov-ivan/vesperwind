// TOAST UI edits LF-only text without a byte order mark. The file keeps its own
// conventions: these helpers strip them for the editor and restore them on save.
const BOM = '﻿'

const count = (text, pattern) => text.match(pattern)?.length || 0

export const describeMarkdownText = (text = '') => {
  const crlf = count(text, /\r\n/g)
  const cr = count(text, /\r(?!\n)/g)
  const lf = count(text, /(?<!\r)\n/g)
  // The dominant line ending wins; ties keep LF.
  const eol = crlf > lf && crlf >= cr ? '\r\n' : cr > lf && cr > crlf ? '\r' : '\n'
  return Object.freeze({
    bom: text.startsWith(BOM),
    eol,
    finalNewline: /[\r\n]$/.test(text),
    mixedLineEndings: [crlf, cr, lf].filter(Boolean).length > 1,
  })
}

export const toEditorMarkdown = (text = '') =>
  (text.startsWith(BOM) ? text.slice(BOM.length) : text).replace(/\r\n?/g, '\n')

export const fromEditorMarkdown = (markdown = '', format = describeMarkdownText('')) => {
  let text = markdown.replace(/\r\n?/g, '\n')
  if (format.finalNewline && text && !text.endsWith('\n')) text += '\n'
  if (format.eol !== '\n') text = text.replace(/\n/g, format.eol)
  return (format.bom ? BOM : '') + text
}
