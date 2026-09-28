import * as XLSX from 'xlsx'
import { createWorkbookModel, validateLegacyWorkbook } from '../model/workbook.js'

const formatColor = (color) => color?.rgb ? `#${color.rgb.slice(-6)}` : undefined
const readStyle = (cell) => {
  const source = cell.s || {}
  const style = {}
  if (cell.z) style.numberFormat = cell.z
  if (source.font?.bold) style.bold = true
  if (source.font?.italic) style.italic = true
  if (source.font?.sz) style.fontSize = source.font.sz
  if (source.font?.color) style.color = formatColor(source.font.color)
  if (source.fill?.fgColor) style.background = formatColor(source.fill.fgColor)
  return style
}

export const parseWorkbook = (bytes) => {
  const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, sheetStubs: true, bookVBA: true })
  if (!workbook.SheetNames.length) throw new Error('Workbook contains no worksheets')
  const sheets = workbook.SheetNames.map((name) => {
    const source = workbook.Sheets[name]
    const range = source['!ref'] ? XLSX.utils.decode_range(source['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
    const cells = []
    for (const [address, cell] of Object.entries(source)) {
      if (address.startsWith('!') || !/^[A-Z]+[1-9][0-9]*$/.test(address)) continue
      const { r: row, c: column } = XLSX.utils.decode_cell(address)
      cells.push({ row, column, type: cell.t, value: cell.v ?? null, formula: cell.f || null, style: readStyle(cell) })
    }
    return {
      name, rowCount: Math.max(range.e.r + 1, 100), columnCount: Math.max(range.e.c + 1, 26),
      cells,
      merges: (source['!merges'] || []).map((merge) => ({ startRow: merge.s.r, endRow: merge.e.r, startColumn: merge.s.c, endColumn: merge.e.c })),
      rows: (source['!rows'] || []).map((row, index) => row ? { index, height: row.hpx || (row.hpt ? row.hpt * 4 / 3 : undefined), hidden: !!row.hidden } : null).filter(Boolean),
      columns: (source['!cols'] || []).map((column, index) => column ? { index, width: column.wpx || (column.wch ? column.wch * 7 + 5 : undefined), hidden: !!column.hidden } : null).filter(Boolean),
    }
  })
  const warnings = []
  if (workbook.vbaraw) warnings.push('VBA macros cannot be preserved')
  return createWorkbookModel({ sheets, date1904: !!workbook.Workbook?.WBProps?.date1904, warnings })
}

export const serializeWorkbook = (model, format) => {
  if (format === 'xls') validateLegacyWorkbook(model)
  const workbook = XLSX.utils.book_new()
  workbook.Workbook = { WBProps: { date1904: model.date1904 || false } }
  for (const sheet of model.sheets) {
    const output = {}
    for (const cell of sheet.cells) {
      const address = XLSX.utils.encode_cell({ r: cell.row, c: cell.column })
      const target = { t: cell.type || (typeof cell.value === 'number' ? 'n' : typeof cell.value === 'boolean' ? 'b' : 's') }
      if (cell.value !== null && cell.value !== undefined) target.v = cell.value
      if (cell.formula) target.f = cell.formula.replace(/^=/, '')
      if (cell.style?.numberFormat) target.z = cell.style.numberFormat
      output[address] = target
    }
    output['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, sheet.rowCount - 1), c: Math.max(0, sheet.columnCount - 1) } })
    if (sheet.merges.length) output['!merges'] = sheet.merges.map((range) => ({ s: { r: range.startRow, c: range.startColumn }, e: { r: range.endRow, c: range.endColumn } }))
    if (sheet.rows.length) output['!rows'] = Object.assign([], ...sheet.rows.map((row) => ({ [row.index]: { hpx: row.height, hidden: row.hidden } })))
    if (sheet.columns.length) output['!cols'] = Object.assign([], ...sheet.columns.map((column) => ({ [column.index]: { wpx: column.width, hidden: column.hidden } })))
    XLSX.utils.book_append_sheet(workbook, output, sheet.name)
  }
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: format === 'xls' ? 'biff8' : 'xlsx', cellStyles: true, compression: format !== 'xls' }))
}
