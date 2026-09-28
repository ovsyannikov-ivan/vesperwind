import { createWorkbookModel } from '../model/workbook.js'

let workbookSequence = 0

const toUniverStyle = (style = {}) => {
  const result = {}
  if (style.numberFormat) result.n = { pattern: style.numberFormat }
  if (style.bold) result.bl = 1
  if (style.italic) result.it = 1
  if (style.fontSize) result.fs = style.fontSize
  if (style.color) result.cl = { rgb: style.color }
  if (style.background) result.bg = { rgb: style.background }
  return result
}
const fromUniverStyle = (style = {}) => ({
  ...(style.n?.pattern ? { numberFormat: style.n.pattern } : {}),
  ...(style.bl ? { bold: true } : {}),
  ...(style.it ? { italic: true } : {}),
  ...(style.fs ? { fontSize: style.fs } : {}),
  ...(style.cl?.rgb ? { color: style.cl.rgb } : {}),
  ...(style.bg?.rgb ? { background: style.bg.rgb } : {}),
})
const univerType = (type) => type === 'n' || type === 'd' ? 2 : type === 'b' ? 3 : 1
const sheetType = (type) => type === 2 ? 'n' : type === 3 ? 'b' : 's'

export const modelToUniver = (model, name = 'Workbook') => {
  const sheets = {}
  const sheetOrder = []
  model.sheets.forEach((sheet, index) => {
    const id = `sheet-${index + 1}`
    sheetOrder.push(id)
    const cellData = {}
    for (const cell of sheet.cells) {
      cellData[cell.row] ||= {}
      cellData[cell.row][cell.column] = {
        ...(cell.value !== null && cell.value !== undefined ? { v: cell.value } : {}),
        t: univerType(cell.type),
        ...(cell.formula ? { f: `=${cell.formula.replace(/^=/, '')}` } : {}),
        ...(Object.keys(cell.style || {}).length ? { s: toUniverStyle(cell.style) } : {}),
      }
    }
    sheets[id] = {
      id, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
      cellData, mergeData: sheet.merges.map((range) => ({ ...range })),
      rowData: Object.fromEntries(sheet.rows.map((row) => [row.index, { h: row.height, hd: row.hidden ? 1 : 0 }])),
      columnData: Object.fromEntries(sheet.columns.map((column) => [column.index, { w: column.width, hd: column.hidden ? 1 : 0 }])),
    }
  })
  return { id: `vesperwind-${Date.now().toString(36)}-${++workbookSequence}`, name, appVersion: '1.0.2', locale: 'enUS',
    dateSystem: model.date1904 ? 'date1904' : 'date1900', styles: {}, sheetOrder, sheets }
}

export const univerToModel = (snapshot) => {
  const sheets = (snapshot.sheetOrder || Object.keys(snapshot.sheets || {})).map((id) => {
    const sheet = snapshot.sheets[id]
    const cells = []
    for (const [row, columns] of Object.entries(sheet.cellData || {})) {
      for (const [column, cell] of Object.entries(columns || {})) {
        const style = typeof cell.s === 'string' ? snapshot.styles?.[cell.s] : cell.s
        cells.push({ row: Number(row), column: Number(column), type: sheetType(cell.t),
          value: cell.v ?? null, formula: cell.f?.replace(/^=/, '') || null, style: fromUniverStyle(style) })
      }
    }
    return {
      name: sheet.name, rowCount: sheet.rowCount || 100, columnCount: sheet.columnCount || 26,
      cells,
      merges: (sheet.mergeData || []).map((range) => ({ startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn })),
      rows: Object.entries(sheet.rowData || {}).map(([index, row]) => ({ index: Number(index), height: row.h || row.ah, hidden: !!row.hd })),
      columns: Object.entries(sheet.columnData || {}).map(([index, column]) => ({ index: Number(index), width: column.w, hidden: !!column.hd })),
    }
  })
  return createWorkbookModel({ sheets, date1904: snapshot.dateSystem === 'date1904' })
}
