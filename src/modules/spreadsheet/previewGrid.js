import * as XLSX from 'xlsx'

export const columnLabel = (column) => XLSX.utils.encode_col(column)
export const formatPreviewCell = (cell, date1904 = false) => {
  if (!cell) return ''
  if (cell.value == null) return cell.formula ? `=${cell.formula.replace(/^=/, '')}` : ''
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  if (typeof cell.value === 'number' && cell.style?.numberFormat) {
    try { return XLSX.SSF.format(cell.style.numberFormat, cell.value, { date1904 }) } catch { /* Display the stored value. */ }
  }
  return String(cell.value)
}

// Render a page of cells instead of allocating a giant HTML table. All populated
// rows/columns remain reachable, including sparse workbooks near Excel's limits.
export const previewSheetBounds = (sheet) => ({
  rows: sheet.merges.reduce((end, merge) => Math.max(end, merge.endRow + 1), sheet.cells.reduce((end, cell) => Math.max(end, cell.row + 1), 1)),
  columns: sheet.merges.reduce((end, merge) => Math.max(end, merge.endColumn + 1), sheet.cells.reduce((end, cell) => Math.max(end, cell.column + 1), 1)),
})
