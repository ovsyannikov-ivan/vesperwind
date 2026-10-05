import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readOoxmlPackage } from '@docx-editor.dev/core/store'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
export const validateNativeOutputs = async (directory) => {
  const rows = []
  const fonts = pathToFileURL(path.resolve('node_modules/pdfjs-dist/standard_fonts') + '/').href
  for (const name of (await fs.readdir(directory)).filter((n) => /\.(pdf|docx)$/.test(n)).sort()) {
    const bytes = new Uint8Array(await fs.readFile(path.join(directory, name)))
    if (name.endsWith('.pdf')) {
      const task = getDocument({ data: bytes, standardFontDataUrl: fonts })
      const doc = await task.promise
      const expectedPages = name.startsWith('representative') || name.startsWith('chart-workbook') ? 8
        : name.startsWith('standard-4-3') || name.startsWith('custom-size') ? 3 : 1
      if (doc.numPages !== expectedPages) throw new Error(`${name}: expected ${expectedPages} pages, got ${doc.numPages}`)
      let text = ''
      for (let page = 1; page <= doc.numPages; page++) {
        const value = await doc.getPage(page)
        const viewport = value.getViewport({ scale: 1 })
        if (!Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) throw new Error(`${name}: invalid PDF geometry`)
        const operators = await value.getOperatorList()
        if (!operators.fnArray.length) throw new Error(`${name}: empty PDF page`)
        const content = await value.getTextContent(); text += content.items.map((item) => item.str || '').join(' ')
      }
      rows.push({ name, bytes: bytes.length, pages: doc.numPages, textCharacters: text.length, pdfjsAccepted: true })
      await task.destroy()
    } else {
      const doc = readOoxmlPackage(bytes)
      if (!doc.ok || !doc.package.mainDocumentPart || !doc.package.parts.has(doc.package.mainDocumentPart)) throw new Error(`${name}: Word reader rejected output`)
      rows.push({ name, bytes: bytes.length, wordReaderAccepted: true, mainDocumentPart: doc.package.mainDocumentPart })
    }
  }
  if (!rows.length) throw new Error('No native Office outputs')
  return rows
}
